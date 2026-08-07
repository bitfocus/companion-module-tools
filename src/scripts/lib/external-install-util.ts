import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function findPackageRoot(filePath: string): Promise<string> {
	let currentDir = path.dirname(filePath)
	while (true) {
		try {
			await readFile(path.join(currentDir, 'package.json'))
			return currentDir
		} catch {
			const parentDir = path.dirname(currentDir)
			if (parentDir === currentDir) throw new Error(`No package.json found for ${filePath}`)
			currentDir = parentDir
		}
	}
}

export async function resolveExternalDependencies(
	moduleDir: string,
	externals: string[],
): Promise<Record<string, string>> {
	const moduleRequire = createRequire(path.join(moduleDir, 'package.json'))
	const dependencies: Record<string, string> = {}
	for (const external of externals) {
		const packageRoot = await findPackageRoot(moduleRequire.resolve(external))
		const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as {
			name?: unknown
			version?: unknown
		}
		if (typeof packageJson.name !== 'string' || typeof packageJson.version !== 'string') {
			throw new Error(`External ${external} has invalid package metadata`)
		}
		dependencies[packageJson.name] = packageJson.version
	}
	return dependencies
}

export async function withInstalledExternalTree<T>(
	dependencies: Record<string, string>,
	inspect: (nodeModulesDir: string) => Promise<T>,
): Promise<T> {
	const stagingDir = await mkdtemp(path.join(tmpdir(), 'companion-license-check-'))
	try {
		await writeFile(
			path.join(stagingDir, 'package.json'),
			JSON.stringify({
				private: true,
				dependencies,
				resolutions: { 'node-gyp': 'npm:empty-npm-package@1.0.0' },
			}),
		)
		await writeFile(path.join(stagingDir, 'yarn.lock'), '')
		await execFileAsync('yarn', ['--cwd', stagingDir, 'install', '--no-immutable'])
		return await inspect(path.join(stagingDir, 'node_modules'))
	} finally {
		await rm(stagingDir, { recursive: true, force: true })
	}
}
