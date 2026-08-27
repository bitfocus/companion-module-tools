/**
 * @param {Record<string, unknown>} argv
 * @returns {boolean}
 */
export function ignoreLicenseRules(argv) {
	const value = argv['ignore-license-rules']
	return value === true || value === 'true'
}
