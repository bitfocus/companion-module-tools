import { realpath, readFile } from 'node:fs/promises'
import path from 'node:path'
import type * as esbuild from 'esbuild'

export type ShippedPackageKind = 'project' | 'bundled' | 'external' | 'prebuild'

export interface ShippedPackage {
	kind: ShippedPackageKind
	name: string
	version?: string
	declaredLicense?: string
	packageRoot: string
	contributingPaths: Set<string>
}

type PackageJson = {
	name?: string
	version?: string
	license?: unknown
}

export function normalizeInventoryPath(inputPath: string, ownerRoot: string): string {
	const relativePath = path.relative(ownerRoot, inputPath)
	if (relativePath === '' || relativePath === '.') return '.'
	if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
		return '<outside package root>'
	}

	return relativePath.split(path.sep).join('/')
}

async function readPackageJson(packageRoot: string): Promise<PackageJson> {
	return JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
}

async function findPackageRoot(inputPath: string, moduleDir: string): Promise<string | undefined> {
	const nodeModulesDir = path.join(moduleDir, 'node_modules')
	let currentDir = path.dirname(inputPath)

	while (currentDir.startsWith(`${nodeModulesDir}${path.sep}`)) {
		try {
			await readFile(path.join(currentDir, 'package.json'))
			return currentDir
		} catch {
			currentDir = path.dirname(currentDir)
		}
	}

	return undefined
}

function getContributingInputs(metafile: esbuild.Metafile): string[] {
	const inputs = new Set<string>()
	for (const [outputPath, output] of Object.entries(metafile.outputs)) {
		if (!outputPath.endsWith('.js')) continue
		for (const [inputPath, input] of Object.entries(output.inputs)) {
			if (input.bytesInOutput > 0) inputs.add(inputPath)
		}
	}
	return [...inputs]
}

export async function collectMetafilePackages(moduleDir: string, metafile: esbuild.Metafile): Promise<ShippedPackage[]> {
	const resolvedModuleDir = await realpath(moduleDir)
	const projectPackageJson = await readPackageJson(resolvedModuleDir)
	const manifestJson = JSON.parse(await readFile(path.join(resolvedModuleDir, 'companion', 'manifest.json'), 'utf8')) as {
		license?: unknown
	}
	const packages = new Map<string, ShippedPackage>()

	for (const input of getContributingInputs(metafile)) {
		if (input.startsWith('<')) continue

		const resolvedInput = path.resolve(resolvedModuleDir, input)
		let inputPath: string
		try {
			inputPath = await realpath(resolvedInput)
		} catch {
			inputPath = resolvedInput
		}

		const packageRoot = (await findPackageRoot(inputPath, resolvedModuleDir)) ?? resolvedModuleDir
		const packageJson = packageRoot === resolvedModuleDir ? projectPackageJson : await readPackageJson(packageRoot)
		const kind: ShippedPackageKind = packageRoot === resolvedModuleDir ? 'project' : 'bundled'
		const key = `${kind}:${packageRoot}`
		let packageInfo = packages.get(key)
		if (!packageInfo) {
			packageInfo = {
				kind,
				name: packageJson.name ?? path.basename(packageRoot),
				version: packageJson.version,
				declaredLicense:
					kind === 'project'
						? typeof manifestJson.license === 'string'
							? manifestJson.license
							: typeof packageJson.license === 'string'
								? packageJson.license
								: undefined
						: typeof packageJson.license === 'string'
							? packageJson.license
							: undefined,
				packageRoot,
				contributingPaths: new Set(),
			}
			packages.set(key, packageInfo)
		}
		packageInfo.contributingPaths.add(normalizeInventoryPath(inputPath, packageRoot))
	}

	return [...packages.values()]
}
