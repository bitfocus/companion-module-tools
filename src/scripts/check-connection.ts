#!/usr/bin/env node
// The zx shebang doesn't resolve dependencies correctly
import 'zx/globals'

import path from 'path'
import { validateManifest } from '@companion-module/base'
import { createRequire } from 'module'
import { findModuleDir, readUTF8File } from './lib/build-util.js'

if (process.platform === 'win32') {
	usePowerShell() // to enable powershell
}

const require = createRequire(import.meta.url)

// const toolsDir = path.join(__dirname, '..')
const toolsDir = await findModuleDir(require.resolve('@companion-module/tools'))
const frameworkDir = await findModuleDir(require.resolve('@companion-module/base'))
console.log(`Checking for: ${process.cwd()}`)

console.log(`Tools path: ${toolsDir}`)
console.log(`Framework path: ${frameworkDir}`)

const manifestJson = JSON.parse(await readUTF8File(path.resolve('./companion/manifest.json')))

try {
	validateManifest(manifestJson, false)
} catch (e) {
	console.error('Manifest validation failed', e)
	process.exit(1)
}
