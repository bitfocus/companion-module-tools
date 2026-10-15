export function ignoreLicenseRules(argv: Record<string, unknown>): boolean {
	const value = argv['ignore-license-rules']
	return value === true || value === 'true'
}

export function ignorePrebuildRules(argv: Record<string, unknown>): boolean {
	const value = argv['ignore-prebuild-rules']
	return value === true || value === 'true'
}
