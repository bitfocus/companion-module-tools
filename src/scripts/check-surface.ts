#!/usr/bin/env node
// The zx shebang doesn't resolve dependencies correctly
import 'zx/globals'

import { createRequire } from 'node:module'
import { validateSurfaceManifest } from '@companion-surface/base'
import { findModuleDir } from './lib/build-util.js'
import { checkPackage } from './lib/check-util.js'
import { LicensePolicyError } from './lib/license-warning-util.js'
import { ignoreLicenseRules } from './lib/cli-options.js'

if (process.platform === 'win32') {
	usePowerShell() // to enable powershell
}

if (argv.help) {
	console.log('Usage: companion-surface-check [--ignore-license-rules]')
	console.log('Checks the companion surface module')
	console.log('  --ignore-license-rules: Report license policy issues as warnings instead of failing')
	process.exit(0)
}

const require = createRequire(import.meta.url)
const toolsDir = await findModuleDir(require.resolve('@companion-module/tools'))
const frameworkDir = await findModuleDir(require.resolve('@companion-surface/base'))
console.log(`Checking for: ${process.cwd()}`)

console.log(`Tools path: ${toolsDir}`)
console.log(`Framework path: ${frameworkDir}`)

try {
	await checkPackage({
		validateManifest: validateSurfaceManifest,
		ignoreLicenseRules: ignoreLicenseRules(argv),
	})
} catch (e) {
	if (e instanceof LicensePolicyError) process.exitCode = 1
	else {
		console.error('Manifest validation failed', e)
		process.exit(1)
	}
}
