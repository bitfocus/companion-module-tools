export function ignoreLicenseRules(argv: Record<string, unknown>): boolean {
	const value = argv['ignore-license-rules']
	return value === true || value === 'true'
}
