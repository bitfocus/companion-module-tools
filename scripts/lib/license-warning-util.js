import parse from 'spdx-expression-parse'

/**
 * @typedef {import('./license-util.js').LegalInventory} LegalInventory
 * @typedef {import('./license-util.js').ShippedPackageLegalRecord} ShippedPackageLegalRecord
 */

/**
 * @typedef {'connection' | 'surface'} ModuleType
 */

/**
 * @typedef {object} LicensePolicyIssue
 * @property {string} packageName
 * @property {string | undefined} [packageVersion]
 * @property {ShippedPackageLegalRecord['kind']} packageKind
 * @property {string} message
 */

/**
 * @typedef {{ allowed: boolean, incompatibleAnd: boolean }} Evaluation
 * @typedef {Pick<NodeJS.WriteStream, 'write'>} LicensePolicyOutput
 */

export class LicensePolicyError extends Error {
	/** @param {LicensePolicyIssue[]} issues */
	constructor(issues) {
		super(`License validation failed with ${issues.length} error${issues.length === 1 ? '' : 's'}.`)
		this.issues = issues
		this.name = 'LicensePolicyError'
	}
}

/**
 * Licenses a module may be declared as, each allowing a different set of dependency licenses
 * @typedef {'MIT' | 'GPL-2.0-only' | 'GPL-3.0-only'} ProjectLicense
 */

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
	'Zlib',
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
/** @type {Record<ProjectLicense, { allowedDependencyLicenses: Set<string> }>} */
const PROJECT_LICENSE_POLICIES = {
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

/** @type {ProjectLicense[]} */
export const SUPPORTED_PROJECT_LICENSES = /** @type {ProjectLicense[]} */ (Object.keys(PROJECT_LICENSE_POLICIES))

/**
 * Policy applied to dependencies while the module itself has no usable license declaration
 * @type {ProjectLicense}
 */
const FALLBACK_PROJECT_LICENSE = 'MIT'

/**
 * Suggested to module authors, as the one which can use the most of npm and be reused most freely
 * @type {ProjectLicense}
 */
const RECOMMENDED_PROJECT_LICENSE = 'MIT'

const LICENSE_HELP_MESSAGE =
	'Not sure what to do about these? Ask in the Bitfocus community Slack, we are happy to help you work out what they mean for your module.'

/**
 * @param {string} declaration
 * @returns {declaration is ProjectLicense}
 */
function isProjectLicense(declaration) {
	return /** @type {string[]} */ (SUPPORTED_PROJECT_LICENSES).includes(declaration)
}

/**
 * @param {string[]} items
 * @returns {string}
 */
function orList(items) {
	const remaining = [...items]
	const last = remaining.pop()
	return remaining.length ? `${remaining.join(', ')} or ${last}` : `${last}`
}

/** @returns {string} */
function supportedProjectLicenseAdvice() {
	const alternatives = SUPPORTED_PROJECT_LICENSES.filter((license) => license !== RECOMMENDED_PROJECT_LICENSE)
	return `We recommend ${RECOMMENDED_PROJECT_LICENSE} for the widest compatibility, but also accept ${orList(alternatives)} when necessary.`
}

/**
 * @param {import('spdx-expression-parse').Info} node
 * @param {Set<string>} allowedLicenses
 * @returns {Evaluation}
 */
function evaluate(node, allowedLicenses) {
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
 *
 * @param {string} declaration
 * @returns {import('spdx-expression-parse').Info | undefined}
 */
function parseLenient(declaration) {
	const tokens = declaration.match(/\(|\)|[^\s()]+/g)
	if (!tokens) return undefined
	let index = 0
	const keyword = (token, word) => token !== undefined && token.toUpperCase() === word

	function parseExpression() {
		let node = parseTerm()
		if (!node) return undefined
		while (keyword(tokens[index], 'OR')) {
			index++
			const right = parseTerm()
			if (!right) return undefined
			node = { left: node, conjunction: 'or', right }
		}
		return node
	}

	function parseTerm() {
		let node = parseFactor()
		if (!node) return undefined
		while (keyword(tokens[index], 'AND')) {
			index++
			const right = parseFactor()
			if (!right) return undefined
			node = { left: node, conjunction: 'and', right }
		}
		return node
	}

	function parseFactor() {
		const token = tokens[index]
		if (token === undefined || token === ')') return undefined
		if (token === '(') {
			index++
			const node = parseExpression()
			if (!node || tokens[index] !== ')') return undefined
			index++
			return node
		}
		if (keyword(token, 'AND') || keyword(token, 'OR') || keyword(token, 'WITH')) return undefined
		index++

		const plus = token.endsWith('+')
		const node = { license: plus ? token.slice(0, -1) : token, plus }
		if (keyword(tokens[index], 'WITH')) {
			index++
			if (tokens[index] === undefined) return undefined
			node.exception = tokens[index]
			index++
		}
		return node
	}

	const node = parseExpression()
	return node && index === tokens.length ? node : undefined
}

/**
 * @param {string} declaration
 * @returns {{ node: import('spdx-expression-parse').Info, strict: boolean } | undefined}
 */
function parseDeclaration(declaration) {
	try {
		return { node: parse(declaration), strict: true }
	} catch {
		const node = parseLenient(declaration)
		return node ? { node, strict: false } : undefined
	}
}

/**
 * @param {ShippedPackageLegalRecord} packageInfo
 * @returns {string}
 */
function normalizedDeclaration(packageInfo) {
	return packageInfo.declaredLicense?.trim() ?? ''
}

/**
 * @param {ShippedPackageLegalRecord} packageInfo
 * @returns {string}
 */
function packageLabel(packageInfo) {
	return `${packageInfo.name}${packageInfo.version ? `@${packageInfo.version}` : ''}`
}

/**
 * @param {string} declaration
 * @returns {string}
 */
function displayDeclaration(declaration) {
	return declaration.replace(/[\u0000-\u001f\u007f]/g, (character) => {
		switch (character) {
			case '\r':
				return '\\r'
			case '\n':
				return '\\n'
			case '\t':
				return '\\t'
			default:
				return `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`
		}
	})
}

/**
 * @param {Evaluation} evaluation
 * @returns {string}
 */
function ambiguitySuffix(evaluation) {
	return evaluation.incompatibleAnd
		? ' Both licenses may apply, making this declaration ambiguous and incompatible. Ask package author to use OR if either license may be chosen, or clarify package licensing.'
		: ''
}

/**
 * @param {ShippedPackageLegalRecord} a
 * @param {ShippedPackageLegalRecord} b
 * @returns {number}
 */
function packageSort(a, b) {
	if (a.kind === 'project' && b.kind !== 'project') return -1
	if (a.kind !== 'project' && b.kind === 'project') return 1
	return (
		a.name.localeCompare(b.name) ||
		(a.version ?? '').localeCompare(b.version ?? '') ||
		normalizedDeclaration(a).localeCompare(normalizedDeclaration(b)) ||
		a.kind.localeCompare(b.kind)
	)
}

/**
 * @param {ShippedPackageLegalRecord} packageInfo
 * @param {string} message
 * @returns {LicensePolicyIssue}
 */
function issue(packageInfo, message) {
	return {
		packageName: packageInfo.name,
		packageVersion: packageInfo.version,
		packageKind: packageInfo.kind,
		message,
	}
}

/**
 * Resolve the license the packaged module is distributed under, which selects the policy applied to its dependencies
 * @param {LegalInventory} inventory
 * @returns {{ declaration: string, license: ProjectLicense | undefined }}
 */
export function resolveProjectLicense(inventory) {
	const projectPackage = inventory.packages.find((packageInfo) => packageInfo.kind === 'project')
	const declaration = projectPackage ? normalizedDeclaration(projectPackage) : ''
	return { declaration, license: isProjectLicense(declaration) ? declaration : undefined }
}

// For now module source must be MIT, so it stays portable whatever the packaged module is distributed as. Relaxing
// this means checking the source license is compatible with the distribution license instead of equal to this one.
const REQUIRED_SOURCE_LICENSE = 'MIT'

/**
 * @param {ShippedPackageLegalRecord} packageInfo
 * @returns {LicensePolicyIssue | undefined}
 */
function createSourceLicenseIssue(packageInfo) {
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

/**
 * @param {ShippedPackageLegalRecord} packageInfo
 * @returns {LicensePolicyIssue | undefined}
 */
function createDistributionLicenseIssue(packageInfo) {
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

/**
 * The distribution and source licenses are declared in different files, and are reported independently
 * @param {ShippedPackageLegalRecord} packageInfo
 * @returns {LicensePolicyIssue[]}
 */
function createProjectIssues(packageInfo) {
	return [createDistributionLicenseIssue(packageInfo), createSourceLicenseIssue(packageInfo)].filter(
		(projectIssue) => projectIssue !== undefined,
	)
}

/**
 * @param {LegalInventory} inventory
 * @returns {LicensePolicyIssue[]}
 */
export function createLicensePolicyIssues(inventory) {
	/** @type {LicensePolicyIssue[]} */
	const result = []
	const seen = new Set()

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

		const parsed = parseDeclaration(declaration)
		if (!parsed) {
			result.push(
				issue(
					packageInfo,
					`Dependency ${packageLabel(packageInfo)} has unparseable license declaration ${displayDeclaration(declaration)}.`,
				),
			)
			continue
		}

		const evaluation = evaluate(parsed.node, allowedLicenses)
		if (evaluation.allowed) continue
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

/**
 * @param {LegalInventory} inventory
 * @param {{ ignoreLicenseRules?: boolean, stderr?: LicensePolicyOutput }} [options]
 * @returns {void}
 */
export function enforceLicensePolicy(inventory, options = {}) {
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
