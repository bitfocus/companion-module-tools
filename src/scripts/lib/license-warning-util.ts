import parse = require('spdx-expression-parse')

export type RestrictedFamily = 'non-commercial' | 'network-copyleft'

export interface LicensePolicyResult {
	restricted: boolean
	families: Set<RestrictedFamily>
	agplOrSsplAndAmbiguity: boolean
	parsed: boolean
}

type Evaluation = Omit<LicensePolicyResult, 'parsed'>
type ExpressionNode = parse.Info

function normalizeExpression(expression: string): string {
	return expression
		.replace(/Server Side Public License/gi, 'SSPL-1.0')
		.replace(/Non-Commercial|NonCommercial/gi, 'LicenseRef-NonCommercial')
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
