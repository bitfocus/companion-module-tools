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
			result.push(
				issue(
					packageInfo,
					declaration
						? `Your module must be licensed under MIT; found ${declaration}.`
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
			const suffix = evaluation.incompatibleAnd
				? ' both licenses may apply, declaration ambiguous and incompatible; ask author to use OR if either license may be chosen or clarify licensing.'
				: ''
			result.push(
				issue(
					packageInfo,
					`Dependency ${packageLabel(packageInfo)} has incompatible license declaration ${declaration}.${suffix}`,
				),
			)
		} catch {
			result.push(
				issue(
					packageInfo,
					`Dependency ${packageLabel(packageInfo)} has unparseable license declaration ${declaration}.`,
				),
			)
		}
	}
	return result
}

// Kept as output adapter until enforcement lands in Task 2.
export function printLicensePolicyIssues(
	issues: LicensePolicyIssue[],
	stderr: Pick<NodeJS.WriteStream, 'write'> = process.stderr,
): void {
	for (const policyIssue of issues) stderr.write(`${policyIssue.message}\n`)
}
