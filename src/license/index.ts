/**
 * The license inventory and policy engine used by the connection and surface module tooling, exposed so that other
 * parts of the Companion project which ship a bundle of npm dependencies can produce the same LICENSE file and apply
 * the same compatibility rules to it.
 *
 * Consumers supply their own overrides (LicenseOverrides) and their own wording (LicensePolicyDescriptor), so that
 * neither has to be maintained here on behalf of a repository this one knows nothing about.
 */
export * from './inventory.js'
export * from './policy.js'
