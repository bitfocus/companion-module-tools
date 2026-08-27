import parse = require('spdx-expression-parse')
import type { LegalInventory, ShippedPackageLegalRecord } from './license-util.js'

export type ModuleType = 'connection' | 'surface'

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

/** Licenses a module may be declared as, each allowing a different set of dependency licenses */
export type ProjectLicense = 'MIT' | 'GPL-2.0-only' | 'GPL-3.0-only'

/** Permissive licenses which may be shipped by a module under any of the supported project licenses */
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

// Each policy pins the combined work to a single GPL version, so no mix of allowed dependencies can end up
// unlicensable. Offering GPL-2.0-or-later would break that, a GPL-2.0-only and a GPL-3.0-only dependency could then
// both be accepted while no version satisfies both.
const PROJECT_LICENSE_POLICIES: Record<ProjectLicense, { allowedDependencyLicenses: Set<string> }> = {
	MIT: {
		allowedDependencyLicenses: new Set([
			...PERMISSIVE_DEPENDENCY_LICENSES,
			'Apache-2.0',
			'CC-BY-3.0',
			'CC-BY-4.0',
			'MPL-2.0', // File level copyleft, allows bundling if source is available (links bundled LICENSE)
			// LGPL: in theory acceptable, but applications must be distributed under terms that permit reverse engineering for debugging
		]),
	},
	// Apache-2.0 and the CC-BY licenses are deliberately absent, they cannot be combined with GPL-2.0-only
	'GPL-2.0-only': {
		allowedDependencyLicenses: new Set([...PERMISSIVE_DEPENDENCY_LICENSES, ...GPL2_DEPENDENCY_LICENSES, 'MPL-2.0']),
	},
	'GPL-3.0-only': {
		allowedDependencyLicenses: new Set([
			...PERMISSIVE_DEPENDENCY_LICENSES,
			...GPL3_DEPENDENCY_LICENSES,
			'GPL-2.0-or-later', // GPL-2.0-only is absent, only the "or later" form can be taken to GPL-3.0
			'Apache-2.0',
			'MPL-2.0',
		]),
	},
}

export const SUPPORTED_PROJECT_LICENSES = Object.keys(PROJECT_LICENSE_POLICIES) as ProjectLicense[]

/** Policy applied to dependencies while the module itself has no usable license declaration */
const FALLBACK_PROJECT_LICENSE: ProjectLicense = 'MIT'

/** Suggested to module authors, as the one which can use the most of npm and be reused most freely */
const RECOMMENDED_PROJECT_LICENSE: ProjectLicense = 'MIT'

const LICENSE_HELP_MESSAGE =
	'Not sure what to do about these? Ask in the Bitfocus community Slack, we are happy to help you work out what they mean for your module.'

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

/** Resolve the license the packaged module is distributed under, which selects the policy applied to its dependencies */
export function resolveProjectLicense(inventory: LegalInventory): {
	declaration: string
	license: ProjectLicense | undefined
} {
	const projectPackage = inventory.packages.find((packageInfo) => packageInfo.kind === 'project')
	const declaration = projectPackage ? normalizedDeclaration(projectPackage) : ''
	return { declaration, license: isProjectLicense(declaration) ? declaration : undefined }
}

// For now module source must be MIT, so it stays portable whatever the packaged module is distributed as. Relaxing
// this means checking the source license is compatible with the distribution license instead of equal to this one.
const REQUIRED_SOURCE_LICENSE = 'MIT'

function createSourceLicenseIssue(packageInfo: ShippedPackageLegalRecord): LicensePolicyIssue | undefined {
	const sourceLicense = packageInfo.sourceLicense?.trim() ?? ''
	if (sourceLicense === REQUIRED_SOURCE_LICENSE) return undefined
	if (!sourceLicense) {
		return issue(
			packageInfo,
			`Your module source does not declare a license in package.json, but the Companion project requires module source to be ${REQUIRED_SOURCE_LICENSE} so it stays portable.`,
		)
	}
	return issue(
		packageInfo,
		`Your module source is licensed as ${displayDeclaration(sourceLicense)} in package.json, but the Companion project requires module source to be ${REQUIRED_SOURCE_LICENSE} so it stays portable. Declare the license the module is distributed under in companion/manifest.json instead.`,
	)
}

function createDistributionLicenseIssue(packageInfo: ShippedPackageLegalRecord): LicensePolicyIssue | undefined {
	const declaration = normalizedDeclaration(packageInfo)
	if (!declaration) {
		return issue(
			packageInfo,
			`Your module does not declare a license in companion/manifest.json. ${supportedProjectLicenseAdvice()} Talk to us if you have a reason to use a different license.`,
		)
	}
	if (isProjectLicense(declaration)) return undefined

	let reason = 'which is not supported'
	try {
		// A declaration with a conjunction is dual licensing, which a module must pick a single license from
		if (!('license' in parse(declaration))) reason = 'and dual licensing is not supported'
	} catch {
		// Report the declaration as unsupported, even when SPDX parsing fails.
	}
	return issue(
		packageInfo,
		`Your module is published under ${displayDeclaration(declaration)}, ${reason}. ${supportedProjectLicenseAdvice()} Talk to us if you have a reason to use a different license.`,
	)
}

/** The distribution and source licenses are declared in different files, and are reported independently */
function createProjectIssues(packageInfo: ShippedPackageLegalRecord): LicensePolicyIssue[] {
	return [createDistributionLicenseIssue(packageInfo), createSourceLicenseIssue(packageInfo)].filter(
		(projectIssue) => projectIssue !== undefined,
	)
}

export function createLicensePolicyIssues(inventory: LegalInventory): LicensePolicyIssue[] {
	const result: LicensePolicyIssue[] = []
	const seen = new Set<string>()

	const projectLicense = resolveProjectLicense(inventory).license ?? FALLBACK_PROJECT_LICENSE
	const allowedLicenses = PROJECT_LICENSE_POLICIES[projectLicense].allowedDependencyLicenses

	for (const packageInfo of [...inventory.packages].sort(packageSort)) {
		const declaration = normalizedDeclaration(packageInfo)
		const identity =
			packageInfo.kind === 'project'
				? 'project'
				: `dependency:${packageInfo.name}@${packageInfo.version ?? ''}:${declaration}`
		if (seen.has(identity)) continue
		seen.add(identity)

		if (packageInfo.kind === 'project') {
			result.push(...createProjectIssues(packageInfo))
			continue
		}

		if (!declaration) {
			result.push(issue(packageInfo, `Dependency ${packageLabel(packageInfo)} has no declared license.`))
			continue
		}

		try {
			const evaluation = evaluate(parse(declaration), allowedLicenses)
			if (evaluation.allowed) continue
			result.push(
				issue(
					packageInfo,
					`Dependency ${packageLabel(packageInfo)} has license declaration ${displayDeclaration(declaration)} which is not compatible with the ${projectLicense} license policy.${ambiguitySuffix(evaluation)}`,
				),
			)
		} catch {
			result.push(
				issue(
					packageInfo,
					`Dependency ${packageLabel(packageInfo)} has unparseable license declaration ${displayDeclaration(declaration)}.`,
				),
			)
		}
	}
	return result
}

export function enforceLicensePolicy(
	inventory: LegalInventory,
	options: { ignoreLicenseRules?: boolean; stderr?: LicensePolicyOutput } = {},
): void {
	const issues = createLicensePolicyIssues(inventory)
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
	stderr.write(`${LICENSE_HELP_MESSAGE}\n`)
	throw new LicensePolicyError(issues)
}
