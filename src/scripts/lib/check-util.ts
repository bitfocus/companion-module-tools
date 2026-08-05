import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createLicenseWarnings, printLicenseWarnings, type ModuleType } from './license-warning-util.js'
import { analyzeShippedLegalInventory } from './license-util.js'

export async function checkPackage<M>(options: {
	moduleType: ModuleType
	validateManifest: (manifest: M, looseChecks: boolean) => void
	cwd?: string
	stderr?: Pick<NodeJS.WriteStream, 'write' | 'isTTY'>
}): Promise<void> {
	const cwd = options.cwd ?? process.cwd()
	const manifest = JSON.parse(await readFile(path.join(cwd, 'companion', 'manifest.json'), 'utf8')) as M
	options.validateManifest(manifest, false)
	const inventory = await analyzeShippedLegalInventory(cwd)
	printLicenseWarnings(createLicenseWarnings(inventory, options.moduleType), options.stderr)
}
