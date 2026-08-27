#!/usr/bin/env node
// The zx shebang doesn't resolve dependencies correctly
import 'zx/globals'

import { buildPackage } from './lib/build-util.js'
import { LicensePolicyError } from './lib/license-warning-util.js'
import { ignoreLicenseRules } from './lib/cli-options.js'

if (process.platform === 'win32') {
	usePowerShell() // to enable powershell
}

if (argv.help) {
	console.log('Usage: companion-module-build [--dev] [--prerelease] [--ignore-license-rules]')
	console.log('Builds the companion connection module')
	console.log('  --dev: Build in development mode. This will not minify the code, making it easier to debug.')
	console.log('  --prerelease: Build in prerelease mode. This gets added as metadata to the manifest')
	console.log('  --output <filename>: Output to a specific filename, without a file extension')
	console.log('  --ignore-license-rules: Report license policy issues as warnings instead of failing')
	process.exit(0)
}

const { validateSurfaceManifest } = await import('@companion-surface/base')

try {
	await buildPackage('@companion-surface/base', validateSurfaceManifest, 'surface', '>=1.0.0 <2.0.0', {
		ignoreLicenseRules: ignoreLicenseRules(argv),
	})
} catch (e) {
	if (e instanceof LicensePolicyError) process.exitCode = 1
	else throw e
}
