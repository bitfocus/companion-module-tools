import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import * as esbuild from 'esbuild'
import type { ModuleBuildConfig } from '../../build-config.js'

export interface ModuleBuildDefinition {
	moduleDir: string
	packageJson: Record<string, unknown>
	buildConfig: ModuleBuildConfig
	entryPoints: Record<string, string>
	externals: string[]
}

export async function loadModuleBuildDefinition(moduleDir: string): Promise<ModuleBuildDefinition> {
	const moduleRequire = createRequire(path.join(moduleDir, 'package.json'))
	const packageJson = JSON.parse(await readFile(path.join(moduleDir, 'package.json'), 'utf8')) as Record<
		string,
		unknown
	>
	if (typeof packageJson.main !== 'string') throw new Error('Missing main in package.json')

	let buildConfig: ModuleBuildConfig = {}
	const buildConfigPath = path.join(moduleDir, 'build-config.cjs')
	try {
		buildConfig = moduleRequire(buildConfigPath) as ModuleBuildConfig
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error
	}
	const externals = Array.isArray(buildConfig.externals)
		? buildConfig.externals
		: buildConfig.externals
			? [buildConfig.externals]
			: []
	return {
		moduleDir,
		packageJson,
		buildConfig,
		entryPoints: { main: `./${packageJson.main}`, ...buildConfig.additionalEntrypoints },
		externals,
	}
}

export function createEsbuildOptions(
	definition: ModuleBuildDefinition,
	overrides: Pick<esbuild.BuildOptions, 'outdir' | 'write' | 'minify' | 'sourcemap'>,
): esbuild.BuildOptions {
	return {
		entryPoints: definition.entryPoints,
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'node22',
		external: definition.externals,
		metafile: true,
		...overrides,
		banner: {
			js: [
				`import { createRequire as __esbuild_createRequire } from 'module';`,
				`import { fileURLToPath as __esbuild_fileURLToPath } from 'url';`,
				`import { dirname as __esbuild_dirname } from 'path';`,
				`const require = __esbuild_createRequire(import.meta.url);`,
				`const __filename = __esbuild_fileURLToPath(import.meta.url);`,
				`const __dirname = __esbuild_dirname(__filename);`,
			].join('\n'),
		},
	}
}
