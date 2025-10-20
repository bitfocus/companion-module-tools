#!/usr/bin/env node
// The zx shebang doesn't resolve dependencies correctly
import 'zx/globals'

import path from 'path'
import { fs } from 'zx'
import { findUp } from 'find-up'
import * as tar from 'tar'
import { createRequire } from 'module'
import * as semver from 'semver'

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

const { validateManifest } = await import('@companion-module/base')

function toSanitizedDirname(name) {
	return name.replace(/[^a-zA-Z0-9-\.]/g, '-').replace(/[-+]/g, '-')
}

const require = createRequire(import.meta.url)

async function findModuleDir(cwd) {
	const stat = await fs.stat(cwd)
	if (stat.isFile()) cwd = path.dirname(cwd)

	const pkgJsonPath = await findUp('package.json', { cwd })
	return path.dirname(pkgJsonPath)
}

// const toolsDir = path.join(__dirname, '..')
const moduleDir = process.cwd()
const toolsDir = await findModuleDir(require.resolve('@companion-module/tools'))
const frameworkDir = await findModuleDir(require.resolve('@companion-module/base'))
console.log(`Building for: ${process.cwd()}`)

console.log(`Tools path: ${toolsDir}`)
console.log(`Framework path: ${frameworkDir}`)

// clean old
await fs.remove('pkg')

// create new
await fs.mkdir(`pkg`)

const packageBaseDir = path.join('pkg')

const webpackArgs = {
	ROOT: moduleDir,
}
if (argv.dev || argv.debug) webpackArgs['dev'] = true

const webpackArgsArray = []
for (const [k, v] of Object.entries(webpackArgs)) {
	webpackArgsArray.push(`--env`, v === true ? k : `${k}=${v}`)
}

// build the code
$.cwd = toolsDir
const webpackConfig = path.join(toolsDir, 'webpack.config.cjs').replace(/\\/g, '/') // Fix slashes because windows is a pain
// use npx to invoke. manual paths does not work on windows, and using `yarn` requires corepack
await $`npx webpack -c ${webpackConfig} ${webpackArgsArray}`
$.cwd = undefined

// copy in the metadata
await fs.copy('companion', path.join(packageBaseDir, 'companion'))

const srcPackageJson = JSON.parse(await fs.readFile(path.resolve('./package.json')))
const frameworkPackageJson = JSON.parse(await fs.readFile(path.join(frameworkDir, 'package.json')))

// Copy the manifest, overriding some properties
const manifestJson = JSON.parse(await fs.readFile(path.resolve('./companion/manifest.json')))
manifestJson.runtime.entrypoint = '../main.js'
manifestJson.version = srcPackageJson.version
manifestJson.runtime.api = 'nodejs-ipc'
manifestJson.runtime.apiVersion = frameworkPackageJson.version

// Bake in the prerelease flag if using module-base which is new enough
if (semver.gt(manifestJson.runtime.apiVersion, '1.12.0-0')) {
	manifestJson.isPrerelease = !!argv.prerelease
}

await fs.writeFile(path.join(packageBaseDir, 'companion/manifest.json'), JSON.stringify(manifestJson))

// Make sure the manifest is valid
try {
	validateManifest(manifestJson)
} catch (e) {
	console.error('Manifest validation failed', e)
	process.exit(1)
}

// Generate a minimal package.json
const packageJson = {
	name: manifestJson.name,
	version: manifestJson.version,
	license: manifestJson.license,
	// Minimal content
	type: 'commonjs',
	dependencies: {},
}

// Ensure that any externals are added as dependencies
const webpackExtPath = path.resolve('build-config.cjs')
if (fs.existsSync(webpackExtPath)) {
	const webpackExt = require(webpackExtPath)

	// Add any external dependencies, with versions matching what is currntly installed
	if (webpackExt.externals) {
		const extArray = Array.isArray(webpackExt.externals) ? webpackExt.externals : [webpackExt.externals]
		for (const extGroup of extArray) {
			if (typeof extGroup === 'object') {
				// TODO - does this need to be a stricter object check?

				for (const external of Object.keys(extGroup)) {
					const extPath = await findUp('package.json', { cwd: require.resolve(external) })
					const extJson = JSON.parse(await fs.readFile(extPath))
					packageJson.dependencies[extJson.name] = extJson.version
				}
			}
		}
	}

	if (webpackExt.forceRemoveNodeGypFromPkg) {
		packageJson.resolutions = {
			'node-gyp': 'npm:empty-npm-package@1.0.0',
		}
	}

	// Copy across any prebuilds that can be loaded corectly
	if (webpackExt.prebuilds) {
		await fs.mkdir(path.join(packageBaseDir, 'prebuilds'))

		for (const lib of webpackExt.prebuilds) {
			const srcDir = await findModuleDir(require.resolve(lib))
			const filesOrDirs = await fs.readdir(path.join(srcDir, 'prebuilds'))
			for (const fileOrDir of filesOrDirs) {
				await fs.copy(path.join(srcDir, 'prebuilds', fileOrDir), path.join(packageBaseDir, 'prebuilds', fileOrDir))
			}
		}
	}

	// copy extra files
	if (Array.isArray(webpackExt.extraFiles)) {
		const files = await globby(webpackExt.extraFiles, {
			expandDirectories: false,
			onlyFiles: false,
		})

		for (const file of files) {
			await fs.copy(file, path.join(packageBaseDir, path.basename(file)), {
				overwrite: false,
			})
		}
	}
}

// Copy node-gyp-build prebulds
const webpackConfigJson = await require(webpackConfig)(webpackArgs)
if (webpackConfigJson.node?.__dirname === true) {
	const copyNodeGypBuildPrebuilds = (thisPath) => {
		const nodeModPath = path.join(thisPath, 'node_modules')
		if (fs.existsSync(nodeModPath)) {
			for (const dir of fs.readdirSync(nodeModPath)) {
				const modDir = path.join(nodeModPath, dir)
				copyNodeGypBuildPrebuilds(modDir)
			}
		}

		const pkgJsonPath = path.join(thisPath, 'package.json')
		if (thisPath && fs.existsSync(pkgJsonPath)) {
			const dirPkgJsonStr = fs.readFileSync(pkgJsonPath)
			const dirPkgJson = JSON.parse(dirPkgJsonStr.toString())

			const prebuildsDir = path.join(thisPath, 'prebuilds')
			if (dirPkgJson.dependencies?.['node-gyp-build'] && fs.existsSync(prebuildsDir)) {
				fs.mkdirpSync(path.join(packageBaseDir, thisPath))
				fs.copySync(prebuildsDir, path.join(packageBaseDir, prebuildsDir))

				console.log('copying node-gyp-build prebuilds from', thisPath)
			}
		}
	}

	copyNodeGypBuildPrebuilds('')
}

// Write the package.json
// packageJson.bundleDependencies = Object.keys(packageJson.dependencies)
await fs.writeFile(path.join(packageBaseDir, 'package.json'), JSON.stringify(packageJson))

// If we found any depenendencies for the pkg, install them
if (Object.keys(packageJson.dependencies).length) {
	await fs.writeFile(path.join(packageBaseDir, 'yarn.lock'), '')
	await $`yarn --cwd ${packageBaseDir} install --no-immutable`
}

// Prune any excessive prebuilds
const prebuildDirName = path.join(packageBaseDir, 'prebuilds')
if (fs.existsSync(prebuildDirName)) {
	const prebuildDirs = await fs.readdir(prebuildDirName)
	for (const dir of prebuildDirs) {
		let keepDir = true
		if (dir.match(/freebsd/) || dir.match(/android/)) {
			// Unsupported platforms
			keepDir = false
		} else if (dir.match(/win32-ia32/)) {
			// 32bit windows is not supported
			keepDir = false
		} else if (dir.match(/linux(.+)musl/)) {
			// linux musl is not supported
			keepDir = false
		} else if (dir.match(/linux-arm$/) || dir.match(/linux-arm-gnueabihf/)) {
			// linux arm (non arm64) is not supported
			keepDir = false
		}

		if (!keepDir) {
			console.log('Removing unneeded prebuild dir:', dir)
			await fs.rm(path.join(prebuildDirName, dir), { recursive: true, force: true })
		}
	}
}

// Create tgz of the build
let tgzFile = toSanitizedDirname(`${manifestJson.id}-${manifestJson.version}`)
if (typeof argv['output'] === 'string') {
	// -o flag, to allow legacy behaviour creating pkg.tgz output
	tgzFile = argv['output']
}
tgzFile += '.tgz'
console.log('Writing compressed package output to', tgzFile)

await tar
	.create(
		{
			gzip: true,
		},
		[packageBaseDir],
	)
	.pipe(fs.createWriteStream(tgzFile))
