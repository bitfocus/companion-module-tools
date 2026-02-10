#!/usr/bin/env node
// The zx shebang doesn't resolve dependencies correctly
import 'zx/globals'

import { buildPackage, isBaseV2API, moduleBaseAPI } from './lib/build-util.js'

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

const base = await moduleBaseAPI()
let validateManifest
if (isBaseV2API(base)) {
	// If a v2.x version of @companion-module/base is being used, it exports the function as a subpath export
	// @ts-ignore @companion-module/base is user-supplied, requiring we ignore a ts error.
	const manifestPkg: typeof import('base-v2/manifest') = await import('@companion-module/base/manifest')
	validateManifest = manifestPkg.validateManifest
} else {
	validateManifest = base.validateManifest
}

await buildPackage('@companion-module/base', validateManifest, 'connection', '>=1.4.0 <3.0.0')
