import parse = require('spdx-expression-parse')
import { correctedPackageLicense } from './inventory.js'
import type { LegalInventory, LicenseOverrides, ShippedPackageLegalRecord } from './inventory.js'

export interface LicensePolicyIssue {
	packageName: string
	packageVersion?: string
	packageKind: ShippedPackageLegalRecord['kind']
	message: string
}

type ExpressionNode = parse.Info
type Evaluation = { allowed: boolean; incompatibleAnd: boolean }
type LicensePolicyOutput = Pick<NodeJS.WriteStream, 'write'>

export class LicensePolicyError extends Error {
	constructor(public readonly issues: LicensePolicyIssue[]) {
		super(`License validation failed with ${issues.length} error${issues.length === 1 ? '' : 's'}.`)
		this.name = 'LicensePolicyError'
	}
}

/** Licenses a project may be declared as, each allowing a different set of dependency licenses */
export type ProjectLicense = 'MIT' | 'GPL-2.0-only' | 'GPL-3.0-only'

/** Permissive licenses which may be shipped under any of the supported project licenses */
const PERMISSIVE_DEPENDENCY_LICENSES = [
	'MIT',
	'MIT-0',
	'ISC',
	'BSD-2-Clause',
	'BSD-3-Clause',
	'0BSD',
	'CC0-1.0',
	'Unlicense',
	'BlueOak-1.0.0',
	'Python-2.0',
	'Zlib',
	'BSL-1.0',
	// Copyleft, but only over the font itself: section 2 permits bundling and redistributing the font with any
	// software, and the reciprocity in sections 3 to 5 only ever reaches a modified version of the font
	'OFL-1.1',
	// Not an SPDX identifier, SPDX has none for a public domain dedication. Recording it as CC0-1.0 or Unlicense
	// would name a specific legal instrument the package never used, and public domain carries no obligation at all.
	'Public-Domain',
]

const GPL2_DEPENDENCY_LICENSES = [
	'GPL-2.0-only',
	'GPL-2.0-or-later',
	'GPL-2.0', // Deprecated SPDX id for GPL-2.0-only, still widely declared on npm
]

const GPL3_DEPENDENCY_LICENSES = [
	'GPL-3.0-only',
	'GPL-3.0-or-later',
	'GPL-3.0', // Deprecated SPDX id for GPL-3.0-only, still widely declared on npm
]

// The LGPL families split by which GPL version their relicensing clause can reach. LGPL-2.x section 3 offers "version
// 2 of the ordinary GPL or any later version", so it suits either GPL policy, while LGPL-3.0 only reaches GPL-3.0.
const LGPL2_DEPENDENCY_LICENSES = [
	'LGPL-2.0-only',
	'LGPL-2.0-or-later',
	'LGPL-2.0', // Deprecated SPDX id for LGPL-2.0-only, still widely declared on npm
	'LGPL-2.1-only',
	'LGPL-2.1-or-later',
	'LGPL-2.1', // Deprecated SPDX id for LGPL-2.1-only
]

const LGPL3_DEPENDENCY_LICENSES = [
	'LGPL-3.0-only',
	'LGPL-3.0-or-later',
	'LGPL-3.0', // Deprecated SPDX id for LGPL-3.0-only
]

// Each policy pins the combined work to a single GPL version, so no mix of allowed dependencies can end up
// unlicensable. Offering GPL-2.0-or-later would break that, a GPL-2.0-only and a GPL-3.0-only dependency could then
// both be accepted while no version satisfies both.
const PROJECT_LICENSE_POLICIES: Record<
	ProjectLicense,
	{ allowedDependencyLicenses: Set<string>; externalOnlyLicenses: Set<string> }
> = {
	MIT: {
		allowedDependencyLicenses: new Set([
			...PERMISSIVE_DEPENDENCY_LICENSES,
			'Apache-2.0',
			'CC-BY-3.0',
			'CC-BY-4.0',
			'MPL-2.0', // File level copyleft, allows bundling if source is available (links bundled LICENSE)
		]),
		// An MIT bundle cannot offer the relinking static linking would require, but the LGPL is written to let a
		// work under any terms use the library as a separate one, so every LGPL version is fine as an external
		externalOnlyLicenses: new Set([...LGPL2_DEPENDENCY_LICENSES, ...LGPL3_DEPENDENCY_LICENSES]),
	},
	// Apache-2.0 and the CC-BY licenses are deliberately absent, they cannot be combined with GPL-2.0-only
	'GPL-2.0-only': {
		allowedDependencyLicenses: new Set([
			...PERMISSIVE_DEPENDENCY_LICENSES,
			...GPL2_DEPENDENCY_LICENSES,
			// Section 3 relicenses these to GPL-2.0, so the bundle stays distributable under this policy
			...LGPL2_DEPENDENCY_LICENSES,
			'MPL-2.0',
		]),
		// LGPL-3.0 is absent entirely rather than external only. It is GPL-3.0 plus permissions, so it carries terms
		// GPL-2.0 section 6 forbids adding, and linking still forms a combined work whichever way it is shipped.
		externalOnlyLicenses: new Set(),
	},
	'GPL-3.0-only': {
		allowedDependencyLicenses: new Set([
			...PERMISSIVE_DEPENDENCY_LICENSES,
			...GPL3_DEPENDENCY_LICENSES,
			'GPL-2.0-or-later', // GPL-2.0-only is absent, only the "or later" form can be taken to GPL-3.0
			// Both families reach GPL-3.0, the 2.x one through its "or any later version" offer
			...LGPL2_DEPENDENCY_LICENSES,
			...LGPL3_DEPENDENCY_LICENSES,
			'Apache-2.0',
			'MPL-2.0',
		]),
		externalOnlyLicenses: new Set(),
	},
}

export const SUPPORTED_PROJECT_LICENSES = Object.keys(PROJECT_LICENSE_POLICIES) as ProjectLicense[]

/** Policy applied to dependencies while the project itself has no usable license declaration */
const FALLBACK_PROJECT_LICENSE: ProjectLicense = 'MIT'

/** Suggested to authors, as the one which can use the most of npm and be reused most freely */
const RECOMMENDED_PROJECT_LICENSE: ProjectLicense = 'MIT'

/**
 * The project-specific wording of the policy, so that the same engine can report issues in terms of whatever it is
 * checking. Everything a message needs to say about how this project declares and ships its licenses lives here.
 */
export interface LicensePolicyDescriptor {
	/** What the project is called in messages, such as "module" or "application" */
	subject: string
	/** Where the license the built artifact ships under is declared, such as "companion/manifest.json" */
	distributionLicenseLocation: string
	/**
	 * The license the project's own source must be declared as in package.json, or undefined when the project has no
	 * rule separating its source license from the license it distributes under.
	 */
	requiredSourceLicense: string | undefined
	/**
	 * How to move a dependency out of the bundle and ship it alongside, or undefined when the project has no way to,
	 * in which case a license which is only acceptable as an external is reported as incompatible instead.
	 */
	externaliseAdvice: string | undefined
	/** Appended once after the issues, to point readers at where they can get help */
	helpMessage: string
}

function isProjectLicense(declaration: string): declaration is ProjectLicense {
	return (SUPPORTED_PROJECT_LICENSES as string[]).includes(declaration)
}

function orList(items: string[]): string {
	const remaining = [...items]
	const last = remaining.pop()
	return remaining.length ? `${remaining.join(', ')} or ${last}` : `${last}`
}

function supportedProjectLicenseAdvice(): string {
	const alternatives = SUPPORTED_PROJECT_LICENSES.filter((license) => license !== RECOMMENDED_PROJECT_LICENSE)
	return `We recommend ${RECOMMENDED_PROJECT_LICENSE} for the widest compatibility, but also accept ${orList(alternatives)} when necessary.`
}

function evaluate(node: ExpressionNode, allowedLicenses: Set<string>): Evaluation {
	if ('license' in node) {
		const license = node.plus ? `${node.license}-or-later` : node.license // "GPL-2.0+" is deprecated for "GPL-2.0-or-later"
		return {
			allowed: !node.exception && allowedLicenses.has(license),
			incompatibleAnd: false,
		}
	}

	const left = evaluate(node.left, allowedLicenses)
	const right = evaluate(node.right, allowedLicenses)
	if (node.conjunction === 'or') {
		const allowed = left.allowed || right.allowed
		return {
			allowed,
			incompatibleAnd: !allowed && (left.incompatibleAnd || right.incompatibleAnd),
		}
	}

	return {
		allowed: left.allowed && right.allowed,
		incompatibleAnd: left.allowed !== right.allowed || left.incompatibleAnd || right.incompatibleAnd,
	}
}

/**
 * spdx-expression-parse rejects the whole expression when any leaf is not a valid SPDX identifier, so a legacy
 * declaration like "(MIT OR GPL)" never reaches the OR logic at all. Re-read those keeping only the boolean
 * structure, so an unrecognised identifier becomes a license which is simply never allowed. OR then still offers a
 * real choice, and AND still requires every branch, so nothing unknown can be accepted on its own.
 */
function parseLenient(declaration: string): ExpressionNode | undefined {
	const tokens = declaration.match(/\(|\)|[^\s()]+/g)
	if (!tokens) return undefined
	let index = 0
	const keyword = (token: string | undefined, word: string): boolean =>
		token !== undefined && token.toUpperCase() === word

	function parseExpression(): ExpressionNode | undefined {
		let node = parseTerm()
		if (!node) return undefined
		while (keyword(tokens![index], 'OR')) {
			index++
			const right = parseTerm()
			if (!right) return undefined
			node = { left: node, conjunction: 'or', right }
		}
		return node
	}

	function parseTerm(): ExpressionNode | undefined {
		let node = parseFactor()
		if (!node) return undefined
		while (keyword(tokens![index], 'AND')) {
			index++
			const right = parseFactor()
			if (!right) return undefined
			node = { left: node, conjunction: 'and', right }
		}
		return node
	}

	function parseFactor(): ExpressionNode | undefined {
		const token = tokens![index]
		if (token === undefined || token === ')') return undefined
		if (token === '(') {
			index++
			const node = parseExpression()
			if (!node || tokens![index] !== ')') return undefined
			index++
			return node
		}
		if (keyword(token, 'AND') || keyword(token, 'OR') || keyword(token, 'WITH')) return undefined
		index++

		const plus = token.endsWith('+')
		const node: parse.LicenseInfo = { license: plus ? token.slice(0, -1) : token }
		if (plus) node.plus = true
		if (keyword(tokens![index], 'WITH')) {
			index++
			if (tokens![index] === undefined) return undefined
			node.exception = tokens![index]
			index++
		}
		return node
	}

	const node = parseExpression()
	return node && index === tokens.length ? node : undefined
}

function parseDeclaration(declaration: string): { node: ExpressionNode; strict: boolean } | undefined {
	try {
		return { node: parse(declaration), strict: true }
	} catch {
		const node = parseLenient(declaration)
		return node ? { node, strict: false } : undefined
	}
}

function normalizedDeclaration(packageInfo: ShippedPackageLegalRecord): string {
	return packageInfo.declaredLicense?.trim() ?? ''
}

function packageLabel(packageInfo: ShippedPackageLegalRecord): string {
	return `${packageInfo.name}${packageInfo.version ? `@${packageInfo.version}` : ''}`
}

function displayDeclaration(declaration: string): string {
	return declaration.replace(/[\u0000-\u001f\u007f]/g, (character) => {
		switch (character) {
			case '\r':
				return '\\r'
			case '\n':
				return '\\n'
			case '\t':
				return '\\t'
			default:
				return `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`
		}
	})
}

function ambiguitySuffix(evaluation: Evaluation): string {
	return evaluation.incompatibleAnd
		? ' Both licenses may apply, making this declaration ambiguous and incompatible. Ask package author to use OR if either license may be chosen, or clarify package licensing.'
		: ''
}

function packageSort(a: ShippedPackageLegalRecord, b: ShippedPackageLegalRecord): number {
	if (a.kind === 'project' && b.kind !== 'project') return -1
	if (a.kind !== 'project' && b.kind === 'project') return 1
	return (
		a.name.localeCompare(b.name) ||
		(a.version ?? '').localeCompare(b.version ?? '') ||
		normalizedDeclaration(a).localeCompare(normalizedDeclaration(b)) ||
		a.kind.localeCompare(b.kind)
	)
}

function issue(packageInfo: ShippedPackageLegalRecord, message: string): LicensePolicyIssue {
	return {
		packageName: packageInfo.name,
		packageVersion: packageInfo.version,
		packageKind: packageInfo.kind,
		message,
	}
}

/** Resolve the license the built artifact is distributed under, which selects the policy applied to its dependencies */
export function resolveProjectLicense(inventory: LegalInventory): {
	declaration: string
	license: ProjectLicense | undefined
} {
	const projectPackage = inventory.packages.find((packageInfo) => packageInfo.kind === 'project')
	const declaration = projectPackage ? normalizedDeclaration(projectPackage) : ''
	return { declaration, license: isProjectLicense(declaration) ? declaration : undefined }
}

function createSourceLicenseIssue(
	packageInfo: ShippedPackageLegalRecord,
	descriptor: LicensePolicyDescriptor,
): LicensePolicyIssue | undefined {
	const required = descriptor.requiredSourceLicense
	if (!required) return undefined // This project draws no distinction between its source and distribution licenses
	const sourceLicense = packageInfo.sourceLicense?.trim() ?? ''
	if (sourceLicense === required) return undefined
	if (!sourceLicense) {
		return issue(
			packageInfo,
			`Your ${descriptor.subject} source does not declare a license in package.json, but the Companion project requires ${descriptor.subject} source to be ${required} so it stays portable.`,
		)
	}
	return issue(
		packageInfo,
		`Your ${descriptor.subject} source is licensed as ${displayDeclaration(sourceLicense)} in package.json, but the Companion project requires ${descriptor.subject} source to be ${required} so it stays portable. Declare the license the ${descriptor.subject} is distributed under in ${descriptor.distributionLicenseLocation} instead.`,
	)
}

function createDistributionLicenseIssue(
	packageInfo: ShippedPackageLegalRecord,
	descriptor: LicensePolicyDescriptor,
): LicensePolicyIssue | undefined {
	const declaration = normalizedDeclaration(packageInfo)
	if (!declaration) {
		return issue(
			packageInfo,
			`Your ${descriptor.subject} does not declare a license in ${descriptor.distributionLicenseLocation}. ${supportedProjectLicenseAdvice()} Talk to us if you have a reason to use a different license.`,
		)
	}
	if (isProjectLicense(declaration)) return undefined

	let reason = 'which is not supported'
	try {
		// A declaration with a conjunction is dual licensing, which a project must pick a single license from
		if (!('license' in parse(declaration))) reason = 'and dual licensing is not supported'
	} catch {
		// Report the declaration as unsupported, even when SPDX parsing fails.
	}
	return issue(
		packageInfo,
		`Your ${descriptor.subject} is published under ${displayDeclaration(declaration)}, ${reason}. ${supportedProjectLicenseAdvice()} Talk to us if you have a reason to use a different license.`,
	)
}

/** The distribution and source licenses may be declared in different files, and are reported independently */
function createProjectIssues(
	packageInfo: ShippedPackageLegalRecord,
	descriptor: LicensePolicyDescriptor,
): LicensePolicyIssue[] {
	return [
		createDistributionLicenseIssue(packageInfo, descriptor),
		createSourceLicenseIssue(packageInfo, descriptor),
	].filter((projectIssue) => projectIssue !== undefined)
}

export function createLicensePolicyIssues(
	inventory: LegalInventory,
	descriptor: LicensePolicyDescriptor,
	overrides: LicenseOverrides,
): LicensePolicyIssue[] {
	const result: LicensePolicyIssue[] = []
	const seen = new Set<string>()

	const projectLicense = resolveProjectLicense(inventory).license ?? FALLBACK_PROJECT_LICENSE
	const policy = PROJECT_LICENSE_POLICIES[projectLicense]
	const bundledLicenses = policy.allowedDependencyLicenses
	// Identical to the bundled set where the policy has nothing which only works as an external, or where the project
	// has no way to externalise, so that no issue is ever reported as fixable in a way which would not in fact help
	const externalLicenses =
		policy.externalOnlyLicenses.size && descriptor.externaliseAdvice
			? new Set([...bundledLicenses, ...policy.externalOnlyLicenses])
			: bundledLicenses

	for (const packageInfo of [...inventory.packages].sort(packageSort)) {
		const declaration = normalizedDeclaration(packageInfo)
		const identity =
			packageInfo.kind === 'project'
				? 'project'
				: `dependency:${packageInfo.name}@${packageInfo.version ?? ''}:${declaration}`
		if (seen.has(identity)) continue
		seen.add(identity)

		if (packageInfo.kind === 'project') {
			result.push(...createProjectIssues(packageInfo, descriptor))
			continue
		}

		if (!declaration) {
			result.push(issue(packageInfo, `Dependency ${packageLabel(packageInfo)} has no declared license.`))
			continue
		}

		let parsed = parseDeclaration(declaration)
		// Only ever replaces a declaration which is not valid SPDX, so a correction can never launder a real license
		if (!parsed || !parsed.strict) {
			const corrected = correctedPackageLicense(overrides, packageInfo.name, packageInfo.version)
			if (corrected) parsed = parseDeclaration(corrected) ?? parsed
		}
		if (!parsed) {
			result.push(
				issue(
					packageInfo,
					`Dependency ${packageLabel(packageInfo)} has unparseable license declaration ${displayDeclaration(declaration)}.`,
				),
			)
			continue
		}

		const allowedLicenses = packageInfo.kind === 'external' ? externalLicenses : bundledLicenses
		const evaluation = evaluate(parsed.node, allowedLicenses)
		if (evaluation.allowed) continue

		// Only reachable for a bundled package, externals are already evaluated against the wider set
		if (descriptor.externaliseAdvice && evaluate(parsed.node, externalLicenses).allowed) {
			result.push(
				issue(
					packageInfo,
					`Dependency ${packageLabel(packageInfo)} has license declaration ${displayDeclaration(declaration)} which may only be shipped as an external dependency, not built into the bundle. ${descriptor.externaliseAdvice}`,
				),
			)
			continue
		}

		if (!parsed.strict) {
			// Reaching here means no branch we could recognise was allowed, so the unrecognised ones are the problem
			result.push(
				issue(
					packageInfo,
					`Dependency ${packageLabel(packageInfo)} has license declaration ${displayDeclaration(declaration)} which is not a valid SPDX identifier, so it cannot be checked against the ${projectLicense} license policy. Ask the package author to declare a specific SPDX license.`,
				),
			)
			continue
		}
		result.push(
			issue(
				packageInfo,
				`Dependency ${packageLabel(packageInfo)} has license declaration ${displayDeclaration(declaration)} which is not compatible with the ${projectLicense} license policy.${ambiguitySuffix(evaluation)}`,
			),
		)
	}
	return result
}

export function enforceLicensePolicy(
	inventory: LegalInventory,
	descriptor: LicensePolicyDescriptor,
	overrides: LicenseOverrides,
	options: { ignoreLicenseRules?: boolean; stderr?: LicensePolicyOutput } = {},
): void {
	const issues = createLicensePolicyIssues(inventory, descriptor, overrides)
	if (issues.length === 0) return
	const stderr = options.stderr ?? process.stderr
	const prefix = options.ignoreLicenseRules ? 'LICENSE WARNING' : 'LICENSE ERROR'
	for (const policyIssue of issues) stderr.write(`${prefix}: ${policyIssue.message}\n`)
	if (options.ignoreLicenseRules) {
		stderr.write(
			`License validation ignored ${issues.length} error${issues.length === 1 ? '' : 's'} because --ignore-license-rules was provided.\n`,
		)
		return
	}
	stderr.write(`License validation failed with ${issues.length} error${issues.length === 1 ? '' : 's'}.\n`)
	stderr.write(`${descriptor.helpMessage}\n`)
	throw new LicensePolicyError(issues)
}
