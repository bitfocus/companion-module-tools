import { readFile } from 'node:fs/promises'
import path from 'node:path'
import * as esbuild from 'esbuild'
import {
	asLicenseString,
	collectInstalledPackages as collectInstalledPackagesWith,
	collectMetafilePackages as collectMetafilePackagesWith,
	createLegalInventory,
	type LegalInventory,
	type PackageCollection,
	type ProjectIdentity,
	type ShippedPackage,
} from '../../license/index.js'
import { createEsbuildOptions, loadModuleBuildDefinition } from './bundle-util.js'
import { resolveExternalDependencies, withInstalledExternalTree } from './external-install-util.js'
import { MODULE_LICENSE_OVERRIDES } from './known-package-licenses.js'

// The engine itself is generic and lives in ../../license, so that it can also be used by the rest of the Companion
// project. These re-exports keep a single import for everything license related in the module scripts and tests.
export {
	NO_LICENSE_OVERRIDES,
	collectPackageLegalMaterial,
	collectPackagesFromInputPaths,
	createLegalInventory,
	getContributingInputs,
	normalizeInventoryPath,
	normalizeLegalText,
	normalizeRepositoryUrl,
	renderLicenseFile,
	renderNoticeFile,
	writeLegalArtifacts,
} from '../../license/index.js'
export type {
	LegalInventory,
	LegalText,
	LicenseOverrides,
	PackageLegalMaterial,
	ProjectIdentity,
	ShippedPackage,
	ShippedPackageKind,
	ShippedPackageLegalRecord,
} from '../../license/index.js'
export type { PackageCollection, PackageCollection as MetafilePackageCollection } from '../../license/index.js'

async function readManifestLicense(moduleDir: string): Promise<unknown> {
	try {
		const manifest = JSON.parse(await readFile(path.join(moduleDir, 'companion', 'manifest.json'), 'utf8'))
		return manifest.license
	} catch {
		return undefined // Modules without a readable manifest fall back to the package.json license
	}
}

/**
 * How a module identifies itself to the engine. The manifest license is what the packaged module is distributed as,
 * which is what its dependencies must fit. package.json only licenses the module's own source, so it is the fallback
 * for modules not declaring the other.
 */
export async function moduleProjectIdentity(moduleDir: string): Promise<ProjectIdentity> {
	return {
		projectRoots: [moduleDir],
		packageRoot: moduleDir,
		name: undefined,
		distributionLicense: asLicenseString(await readManifestLicense(moduleDir)),
	}
}

/** Scans a dependency tree installed alongside a module, applying the module tooling's own license overrides */
export async function collectInstalledPackages(nodeModulesDir: string): Promise<ShippedPackage[]> {
	return collectInstalledPackagesWith(nodeModulesDir, MODULE_LICENSE_OVERRIDES)
}

/** Attributes the inputs of a module's esbuild metafile, applying the module tooling's own license overrides */
export async function collectMetafilePackages(
	moduleDir: string,
	metafile: esbuild.Metafile,
): Promise<PackageCollection> {
	return collectMetafilePackagesWith(
		metafile,
		moduleDir,
		await moduleProjectIdentity(moduleDir),
		MODULE_LICENSE_OVERRIDES,
	)
}

export async function analyzeShippedLegalInventory(moduleDir: string): Promise<LegalInventory> {
	const definition = await loadModuleBuildDefinition(moduleDir)
	const result = await esbuild.build(
		createEsbuildOptions(definition, {
			outdir: path.join(moduleDir, '.license-analysis'),
			write: false,
			minify: false,
			sourcemap: false,
		}),
	)
	if (!result.metafile) throw new Error('esbuild did not produce a metafile')
	const metafilePackages = await collectMetafilePackages(moduleDir, result.metafile)
	const packages = [...metafilePackages.packages]
	if (definition.externals.length) {
		const dependencies = await resolveExternalDependencies(moduleDir, definition.externals)
		packages.push(...(await withInstalledExternalTree(dependencies, collectInstalledPackages)))
	}
	const inventory = await createLegalInventory(packages)
	return { ...inventory, diagnostics: [...metafilePackages.diagnostics, ...inventory.diagnostics] }
}
