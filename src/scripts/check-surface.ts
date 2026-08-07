#!/usr/bin/env node
// The zx shebang doesn't resolve dependencies correctly
import 'zx/globals'

import { createRequire } from 'node:module'
import { validateSurfaceManifest } from '@companion-surface/base'
import { findModuleDir } from './lib/build-util.js'
import { checkPackage } from './lib/check-util.js'

if (process.platform === 'win32') {
	usePowerShell() // to enable powershell
}

const require = createRequire(import.meta.url)
const toolsDir = await findModuleDir(require.resolve('@companion-module/tools'))
const frameworkDir = await findModuleDir(require.resolve('@companion-surface/base'))
console.log(`Checking for: ${process.cwd()}`)

console.log(`Tools path: ${toolsDir}`)
console.log(`Framework path: ${frameworkDir}`)

try {
	await checkPackage({ moduleType: 'surface', validateManifest: validateSurfaceManifest })
} catch (e) {
	console.error('Manifest validation failed', e)
	process.exit(1)
}
