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

let { validateManifest } = await import('@companion-module/base')
if (!validateManifest) {
	// If a v2.x version of @companion-module/base is being used, it exports the function as a subpath export
	const manifestPkg = await import('@companion-module/base/manifest')
	validateManifest = manifestPkg.validateManifest
}

try {
	await buildPackage('@companion-module/base', validateManifest, 'connection', '>=1.4.0 <3.0.0', {
		ignoreLicenseRules: ignoreLicenseRules(argv),
	})
} catch (e) {
	if (e instanceof LicensePolicyError) process.exitCode = 1
	else throw e
}
