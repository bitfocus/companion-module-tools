#!/usr/bin/env node
// The zx shebang doesn't resolve dependencies correctly
import 'zx/globals'

import path from 'path'
import { fs } from 'zx'
import { findUp } from 'find-up'
import { validateManifest } from '@companion-module/base'
import { createRequire } from 'module'
import { checkPackage } from './lib/check-util.js'
import { LicensePolicyError } from './lib/license-warning-util.js'
import { ignoreLicenseRules } from './lib/cli-options.js'

if (process.platform === 'win32') {
	usePowerShell() // to enable powershell
}

if (argv.help) {
	console.log('Usage: companion-module-check [--ignore-license-rules]')
	console.log('Checks the companion connection module')
	console.log('  --ignore-license-rules: Report license policy issues as warnings instead of failing')
	process.exit(0)
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

try {
	await checkPackage({ validateManifest, ignoreLicenseRules: ignoreLicenseRules(argv) })
} catch (e) {
	if (e instanceof LicensePolicyError) process.exitCode = 1
	else {
		console.error('Manifest validation failed', e)
		process.exit(1)
	}
}
