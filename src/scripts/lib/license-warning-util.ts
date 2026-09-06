import {
	createLicensePolicyIssues as createLicensePolicyIssuesWith,
	enforceLicensePolicy as enforceLicensePolicyWith,
	type LegalInventory,
	type LicensePolicyDescriptor,
	type LicensePolicyIssue,
} from '../../license/index.js'
import { MODULE_LICENSE_OVERRIDES } from './known-package-licenses.js'

// The engine itself is generic and lives in ../../license, so that it can also be used by the rest of the Companion
// project. These re-exports keep a single import for everything license related in the module scripts and tests.
export { LicensePolicyError, SUPPORTED_PROJECT_LICENSES, resolveProjectLicense } from '../../license/index.js'
export type { LicensePolicyDescriptor, LicensePolicyIssue, ProjectLicense } from '../../license/index.js'

export type ModuleType = 'connection' | 'surface'

/** How the policy engine talks about a module: what it is called, where it declares its licenses, and how it ships */
export const MODULE_LICENSE_POLICY: LicensePolicyDescriptor = {
	subject: 'module',
	distributionLicenseLocation: 'companion/manifest.json',
	// For now module source must be MIT, so it stays portable whatever the packaged module is distributed as.
	// Relaxing this means checking the source license is compatible with the distribution license instead of equal.
	requiredSourceLicense: 'MIT',
	externaliseAdvice:
		'Add it to the externals in build-config.cjs so it is installed alongside the module and loaded at runtime.',
	helpMessage:
		'Not sure what to do about these? Ask in the Bitfocus community Slack, we are happy to help you work out what they mean for your module.',
}

export function createLicensePolicyIssues(inventory: LegalInventory): LicensePolicyIssue[] {
	return createLicensePolicyIssuesWith(inventory, MODULE_LICENSE_POLICY, MODULE_LICENSE_OVERRIDES)
}

export function enforceLicensePolicy(
	inventory: LegalInventory,
	options: { ignoreLicenseRules?: boolean; stderr?: Pick<NodeJS.WriteStream, 'write'> } = {},
): void {
	enforceLicensePolicyWith(inventory, MODULE_LICENSE_POLICY, MODULE_LICENSE_OVERRIDES, options)
}
