#!/usr/bin/env node
// The zx shebang doesn't resolve dependencies correctly
import 'zx/globals'

import { buildPackage } from './lib/build-util.js'

if (process.platform === 'win32') {
	usePowerShell() // to enable powershell
}

if (argv.help) {
	console.log('Usage: companion-module-build [--dev] [--prerelease]')
	console.log('Builds the companion connection module')
	console.log('  --dev: Build in development mode. This will not minify the code, making it easier to debug.')
	console.log('  --prerelease: Build in prerelease mode. This gets added as metadata to the manifest')
	console.log('  --output <filename>: Output to a specific filename, without a file extension')
	process.exit(0)
}

let { validateManifest } = await import('@companion-module/base')
if (!validateManifest) {
	// If a v2.x version of @companion-module/base is being used, it exports the function as a subpath export
	const manifestPkg = await import('@companion-module/base/manifest')
	validateManifest = manifestPkg.validateManifest
}

await buildPackage('@companion-module/base', validateManifest, 'connection', '>=1.4.0 <3.0.0')
