import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { enforceLicensePolicy } from './license-warning-util.js'
import { analyzeShippedLegalInventory } from './license-util.js'

/**
 * @param {object} options
 * @param {(manifest: any, looseChecks: boolean) => void} options.validateManifest
 * @param {string} [options.cwd]
 * @param {boolean} [options.ignoreLicenseRules]
 * @param {Pick<NodeJS.WriteStream, 'write' | 'isTTY'>} [options.stderr]
 * @returns {Promise<void>}
 */
export async function checkPackage(options) {
	const cwd = options.cwd ?? process.cwd()
	const manifest = JSON.parse(await readFile(path.join(cwd, 'companion', 'manifest.json'), 'utf8'))
	options.validateManifest(manifest, false)
	const inventory = await analyzeShippedLegalInventory(cwd)
	enforceLicensePolicy(inventory, {
		ignoreLicenseRules: options.ignoreLicenseRules,
		stderr: options.stderr,
	})
}
