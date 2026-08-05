import 'zx/globals'

import path from 'path'
import { fs } from 'zx'
import { findUp } from 'find-up'
import * as tar from 'tar'
import { createRequire } from 'module'
import * as semver from 'semver'
import * as esbuild from 'esbuild'
import {
	collectInstalledPackages,
	collectMetafilePackages,
	createLegalInventory,
	writeLegalArtifacts,
} from './license-util.js'
import { createEsbuildOptions, isSupportedPrebuildDir, loadModuleBuildDefinition } from './bundle-util.js'
import { resolveExternalDependencies } from './external-install-util.js'
import { createLicenseWarnings, printLicenseWarnings, type ModuleType } from './license-warning-util.js'
import type { LegalInventory } from './license-util.js'

function toSanitizedDirname(name: string) {
	return name.replace(/[^a-zA-Z0-9-\.]/g, '-').replace(/[-+]/g, '-')
}

const require = createRequire(import.meta.url)

export async function readUTF8File(filePath: string): Promise<string> {
	return fs.readFile(filePath, { encoding: 'utf8' })
}

export async function findModuleDir(cwd: string) {
	const stat = await fs.stat(cwd)
	if (stat.isFile()) cwd = path.dirname(cwd)

	const pkgJsonPath = await findUp('package.json', { cwd })
	if (pkgJsonPath === undefined) {
		throw new Error('No package.json file found in an enclosing directory')
	}
	return path.dirname(pkgJsonPath)
}

export function warnForLegalInventory(
	inventory: LegalInventory,
	moduleType: ModuleType,
	stderr?: Pick<NodeJS.WriteStream, 'write' | 'isTTY'>,
): void {
	printLicenseWarnings(createLicenseWarnings(inventory, moduleType), stderr)
}

export async function buildPackage<M>(
	frameworkPackageName: string,
	validateManifest: (manifest: M, looseChecks: boolean) => void,
	moduleType: ModuleType,
	versionRange: string,
) {
	// const toolsDir = path.join(__dirname, '..')
	const moduleDir = process.cwd()
	const moduleRequire = createRequire(path.join(moduleDir, 'package.json'))
	const toolsDir = await findModuleDir(require.resolve('@companion-module/tools'))
	const frameworkDir = await findModuleDir(require.resolve(frameworkPackageName))
	console.log(`Building for: ${process.cwd()}`)

	console.log(`Tools path: ${toolsDir}`)
	console.log(`Framework path: ${frameworkDir}`)

	// Check for Yarn PnP
	const pnpFile = path.join(moduleDir, '.pnp.cjs')
	const pnpFileAlt = path.join(moduleDir, '.pnp.js')
	if ((await fs.pathExists(pnpFile)) || (await fs.pathExists(pnpFileAlt))) {
		console.error("❌ Error: Yarn PnP (Plug'n'Play) is not supported.")
		console.error('   The companion module build process requires a traditional node_modules structure.')
		console.error('   Please add "nodeLinker: node-modules" to your .yarnrc.yml file and run "yarn install".')
		process.exit(1)
	}

	const srcPackageJson = JSON.parse(await readUTF8File(path.resolve('./package.json')))
	const frameworkPackageJson = JSON.parse(await readUTF8File(path.join(frameworkDir, 'package.json')))

	// Check framework version if range is specified
	if (versionRange && !semver.satisfies(frameworkPackageJson.version, versionRange, { includePrerelease: true })) {
		console.error(`Error: ${frameworkPackageName} version ${frameworkPackageJson.version} is not supported.`)
		console.error(`Required version range: ${versionRange}`)
		process.exit(1)
	}

	const manifestJson = JSON.parse(await readUTF8File(path.resolve('./companion/manifest.json')))

	// clean old
	await fs.remove('pkg')

	const innerFolderName = toSanitizedDirname(manifestJson.id)
	const packageBaseDir = path.join('pkg', innerFolderName)

	// create new
	await fs.mkdir(packageBaseDir, { recursive: true })

	const isDev = !!(argv.dev || argv.debug)

	const buildDefinition = await loadModuleBuildDefinition(moduleDir)
	const buildConfig = buildDefinition.buildConfig
	if (fs.existsSync(path.join(moduleDir, 'build-config.cjs'))) console.log('Found additional build configuration')
	const externalsRaw = buildDefinition.externals

	// build the code
	const esbuildOptions = createEsbuildOptions(buildDefinition, {
		outdir: path.resolve(moduleDir, packageBaseDir),
		minify: isDev ? false : !buildConfig.disableMinifier,
		sourcemap: isDev ? 'inline' : false,
	})

	const buildResult = await esbuild.build(esbuildOptions)
	if (!buildResult.metafile) throw new Error('esbuild did not produce a metafile')
	const metafilePackages = await collectMetafilePackages(moduleDir, buildResult.metafile)

	// copy in the metadata
	await fs.copy('companion', path.join(packageBaseDir, 'companion'))

	// Copy the manifest, overriding some properties
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
		validateManifest(manifestJson, false)
	} catch (e) {
		console.error('Manifest validation failed', e)
		process.exit(1)
	}

	type MinimalPackageJson = {
		name: string
		version: string
		license: string
		type: 'module'
		dependencies: Record<string, string>
		resolutions?: Record<string, string>
	}

	// Generate a minimal package.json
	const packageJson: MinimalPackageJson = {
		name: moduleType === 'connection' ? manifestJson.name : manifestJson.id,
		version: manifestJson.version,
		license: manifestJson.license,
		// Minimal content
		type: 'module',
		dependencies: {},
	}

	// Ensure that any externals are added as dependencies
	if (externalsRaw.length) {
		Object.assign(packageJson.dependencies, await resolveExternalDependencies(moduleDir, externalsRaw))

		// Ensure node-gyp is excluded from the installed deps in the output package
		packageJson.resolutions = {
			'node-gyp': 'npm:empty-npm-package@1.0.0',
		}
	}

	// Copy across any prebuilds that can be loaded correctly
	if (buildConfig.prebuilds) {
		await fs.mkdir(path.join(packageBaseDir, 'prebuilds'))

		for (const lib of buildConfig.prebuilds) {
			const srcDir = await findModuleDir(moduleRequire.resolve(lib))
			const filesOrDirs = await fs.readdir(path.join(srcDir, 'prebuilds'))
			for (const fileOrDir of filesOrDirs) {
				await fs.copy(path.join(srcDir, 'prebuilds', fileOrDir), path.join(packageBaseDir, 'prebuilds', fileOrDir))
			}
		}
	}

	// copy extra files
	if (Array.isArray(buildConfig.extraFiles)) {
		const files = await globby(buildConfig.extraFiles, {
			expandDirectories: false,
			onlyFiles: false,
		})

		for (const file of files) {
			await fs.copy(file, path.join(packageBaseDir, path.basename(file)), {
				overwrite: false,
			})
		}
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
			if (!isSupportedPrebuildDir(dir)) {
				console.log('Removing unneeded prebuild dir:', dir)
				await fs.rm(path.join(prebuildDirName, dir), { recursive: true, force: true })
			}
		}
	}

	const shippedPackages = [...metafilePackages.packages]
	if (Object.keys(packageJson.dependencies).length) {
		shippedPackages.push(...(await collectInstalledPackages(path.join(packageBaseDir, 'node_modules'))))
	}
	const legalInventory = await createLegalInventory(shippedPackages)
	for (const diagnostic of [...metafilePackages.diagnostics, ...legalInventory.diagnostics]) {
		console.warn(`License inventory: ${diagnostic}`)
	}
	await writeLegalArtifacts(packageBaseDir, legalInventory)
	warnForLegalInventory(legalInventory, moduleType)

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
				cwd: 'pkg',
			},
			[innerFolderName],
		)
		.pipe(fs.createWriteStream(tgzFile))
}
