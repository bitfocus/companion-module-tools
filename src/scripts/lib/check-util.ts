import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { enforceLicensePolicy } from './license-warning-util.js'
import { analyzeShippedLegalInventory } from './license-util.js'

export async function checkPackage<M>(options: {
	validateManifest: (manifest: M, looseChecks: boolean) => void
	cwd?: string
	ignoreLicenseRules?: boolean
	stderr?: Pick<NodeJS.WriteStream, 'write' | 'isTTY'>
}): Promise<void> {
	const cwd = options.cwd ?? process.cwd()
	const manifest = JSON.parse(await readFile(path.join(cwd, 'companion', 'manifest.json'), 'utf8')) as M
	options.validateManifest(manifest, false)
	const inventory = await analyzeShippedLegalInventory(cwd)
	enforceLicensePolicy(inventory, {
		ignoreLicenseRules: options.ignoreLicenseRules,
		stderr: options.stderr,
	})
}
