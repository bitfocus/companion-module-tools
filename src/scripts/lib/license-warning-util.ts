import parse = require('spdx-expression-parse')
import type { LegalInventory } from './license-util.js'

export type RestrictedFamily = 'non-commercial' | 'network-copyleft'

export interface LicensePolicyResult {
	restricted: boolean
	families: Set<RestrictedFamily>
	agplOrSsplAndAmbiguity: boolean
	parsed: boolean
}

export type ModuleType = 'connection' | 'surface'

export interface LicenseWarning {
	severity: 'restricted' | 'ambiguity'
	text: string
}

type Evaluation = Omit<LicensePolicyResult, 'parsed'>
type ExpressionNode = parse.Info

function normalizeExpression(expression: string): string {
	return expression
		.replace(/Server Side Public License/gi, 'SSPL-1.0')
		.replace(/\bSSPL\b(?!-1\.0)/gi, 'SSPL-1.0')
		.replace(/Non-Commercial|NonCommercial|CC-NC/gi, 'LicenseRef-NonCommercial')
		.replace(/AGPLv3/gi, 'AGPL-3.0-only')
}

function familyForLicense(license: string): RestrictedFamily | undefined {
	const normalized = license.toUpperCase()
	if (normalized === 'SSPL-1.0' || normalized === 'AGPL-3.0' || normalized.startsWith('AGPL-3.0-')) {
		return 'network-copyleft'
	}
	if (normalized === 'LICENSEREF-NONCOMMERCIAL' || /(^|-)NC(-|$)/.test(normalized)) return 'non-commercial'
	return undefined
}

function evaluate(node: ExpressionNode): Evaluation {
	if ('license' in node) {
		const family = familyForLicense(node.license)
		return {
			restricted: family !== undefined,
			families: family ? new Set([family]) : new Set(),
			agplOrSsplAndAmbiguity: false,
		}
	}

	const left = evaluate(node.left)
	const right = evaluate(node.right)
	if (node.conjunction === 'or') {
		const restricted = left.restricted && right.restricted
		return {
			restricted,
			families: restricted ? new Set([...left.families, ...right.families]) : new Set(),
			agplOrSsplAndAmbiguity: restricted && (left.agplOrSsplAndAmbiguity || right.agplOrSsplAndAmbiguity),
		}
	}

	const restricted = left.restricted || right.restricted
	const hasNetworkCopyleft = left.families.has('network-copyleft') || right.families.has('network-copyleft')
	return {
		restricted,
		families: new Set([...left.families, ...right.families]),
		agplOrSsplAndAmbiguity:
			restricted && (hasNetworkCopyleft || left.agplOrSsplAndAmbiguity || right.agplOrSsplAndAmbiguity),
	}
}

export function classifyLicenseExpression(expression: string | undefined): LicensePolicyResult {
	if (!expression?.trim())
		return { restricted: false, families: new Set(), agplOrSsplAndAmbiguity: false, parsed: false }
	try {
		const result = evaluate(parse(normalizeExpression(expression)))
		return { ...result, parsed: true }
	} catch {
		return { restricted: false, families: new Set(), agplOrSsplAndAmbiguity: false, parsed: false }
	}
}

function packageSort(a: LegalInventory['packages'][number], b: LegalInventory['packages'][number]): number {
	if (a.kind === 'project' && b.kind !== 'project') return -1
	if (a.kind !== 'project' && b.kind === 'project') return 1
	return a.name.localeCompare(b.name) || (a.version ?? '').localeCompare(b.version ?? '')
}

export function createLicenseWarnings(inventory: LegalInventory, moduleType: ModuleType): LicenseWarning[] {
	const warnings: LicenseWarning[] = []
	const warnedIdentities = new Set<string>()
	for (const packageInfo of [...inventory.packages].sort(packageSort)) {
		const identity = `${packageInfo.kind === 'project' ? 'project' : 'dependency'}:${packageInfo.name}@${packageInfo.version ?? ''}:${packageInfo.declaredLicense ?? ''}`
		if (warnedIdentities.has(identity)) continue
		warnedIdentities.add(identity)
		const policy = classifyLicenseExpression(packageInfo.declaredLicense)
		if (!policy.restricted || !packageInfo.declaredLicense) continue

		const subject = moduleType === 'connection' ? 'module' : 'surface'
		const project = packageInfo.kind === 'project'
		const restriction =
			moduleType === 'connection'
				? project
					? `This module is licensed under ${packageInfo.declaredLicense}, which makes it unavailable in Bitfocus Buttons.`
					: `Dependency ${packageInfo.name}${packageInfo.version ? `@${packageInfo.version}` : ''} is licensed under ${packageInfo.declaredLicense}, which makes this module unavailable in Bitfocus Buttons.`
				: project
					? `This surface is licensed under ${packageInfo.declaredLicense}, which may restrict distribution or use.`
					: `Dependency ${packageInfo.name}${packageInfo.version ? `@${packageInfo.version}` : ''} is licensed under ${packageInfo.declaredLicense}, which may restrict this surface's distribution or use.`
		const networkWarning = policy.families.has('network-copyleft')
			? ` Some commercial users of Companion might be limited by this ${subject} when it is used over the network.`
			: ''
		warnings.push({ severity: 'restricted', text: `WARNING: ${restriction}${networkWarning}` })
		if (policy.agplOrSsplAndAmbiguity) {
			warnings.push({
				severity: 'ambiguity',
				text: `LICENSE AMBIGUITY: The warning above is shown because ${packageInfo.declaredLicense} combines AGPLv3/SSPL obligations using AND; confirm the intended licensing terms.`,
			})
		}
	}
	return warnings
}

export function formatLicenseWarning(warning: LicenseWarning, isTTY: boolean): string {
	if (!isTTY) return warning.text
	const color = warning.severity === 'restricted' ? '\u001b[38;5;208m' : '\u001b[33m'
	return `${color}${warning.text}\u001b[0m`
}

export function printLicenseWarnings(
	warnings: LicenseWarning[],
	stderr: Pick<NodeJS.WriteStream, 'write' | 'isTTY'> = process.stderr,
): void {
	for (const warning of warnings) stderr.write(`${formatLicenseWarning(warning, Boolean(stderr.isTTY))}\n`)
}
