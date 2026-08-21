export function ignoreLicenseRules(argv: Record<string, unknown>): boolean {
	return Boolean(argv['ignore-license-rules'])
}
