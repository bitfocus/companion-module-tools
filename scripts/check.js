#!/usr/bin/env node
// The zx shebang doesn't resolve dependencies correctly
import 'zx/globals'

import path from 'path'
import { fs } from 'zx'
import { findUp } from 'find-up'
import { validateManifest } from '@companion-module/base'
import { createRequire } from 'module'

if (process.platform === 'win32') {
	usePowerShell() // to enable powershell
}

const require = createRequire(import.meta.url)

async function findModuleDir(cwd) {
	const stat = await fs.stat(cwd)
	if (stat.isFile()) cwd = path.dirname(cwd)

	const pkgJsonPath = await findUp('package.json', { cwd })
	return path.dirname(pkgJsonPath)
}

// const toolsDir = path.join(__dirname, '..')
const toolsDir = await findModuleDir(require.resolve('@companion-module/tools'))
const frameworkDir = await findModuleDir(require.resolve('@companion-module/base'))
console.log(`Checking for: ${process.cwd()}`)

console.log(`Tools path: ${toolsDir}`)
console.log(`Framework path: ${frameworkDir}`)

const manifestJson = JSON.parse(await fs.readFile(path.resolve('./companion/manifest.json')))

try {
	validateManifest(manifestJson)
} catch (e) {
	console.error('Manifest validation failed', e)
	process.exit(1)
}
