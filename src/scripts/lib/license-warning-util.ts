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

const ALLOWED_DEPENDENCY_LICENSES = new Set(['MIT', 'ISC', 'BSD-2-Clause'])

function evaluate(node: ExpressionNode): Evaluation {
	if ('license' in node)
		return {
			allowed: !node.exception && !node.plus && ALLOWED_DEPENDENCY_LICENSES.has(node.license),
			incompatibleAnd: false,
		}

	const left = evaluate(node.left)
	const right = evaluate(node.right)
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

export function createLicensePolicyIssues(inventory: LegalInventory): LicensePolicyIssue[] {
	const result: LicensePolicyIssue[] = []
	const seen = new Set<string>()

	for (const packageInfo of [...inventory.packages].sort(packageSort)) {
		const declaration = normalizedDeclaration(packageInfo)
		const identity =
			packageInfo.kind === 'project'
				? 'project'
				: `dependency:${packageInfo.name}@${packageInfo.version ?? ''}:${declaration}`
		if (seen.has(identity)) continue
		seen.add(identity)

		if (packageInfo.kind === 'project') {
			if (declaration === 'MIT') continue
			let suffix = ''
			if (declaration) {
				try {
					suffix = ambiguitySuffix(evaluate(parse(declaration)))
				} catch {
					// Project rule reports declaration as non-MIT, even when SPDX parsing fails.
				}
			}
			const displayedDeclaration = displayDeclaration(declaration)
			result.push(
				issue(
					packageInfo,
					declaration
						? `Your module must be licensed under MIT; found ${displayedDeclaration}.${suffix}`
						: 'Your module must be licensed under MIT; no declared license found.',
				),
			)
			continue
		}

		if (!declaration) {
			result.push(issue(packageInfo, `Dependency ${packageLabel(packageInfo)} has no declared license.`))
			continue
		}

		try {
			const evaluation = evaluate(parse(declaration))
			if (evaluation.allowed) continue
			result.push(
				issue(
					packageInfo,
					`Dependency ${packageLabel(packageInfo)} has incompatible license declaration ${displayDeclaration(declaration)}.${ambiguitySuffix(evaluation)}`,
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
	throw new LicensePolicyError(issues)
}
