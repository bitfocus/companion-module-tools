import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
	collectInstalledPackages,
	collectMetafilePackages,
	collectPackageLegalMaterial,
	collectPrebuildPackages,
	normalizeInventoryPath,
} from '../dist/scripts/lib/license-util.js'

async function writeJson(filePath, value) {
	await mkdir(path.dirname(filePath), { recursive: true })
	await writeFile(filePath, JSON.stringify(value))
}

async function createProjectFixture() {
	const projectDir = await mkdtemp(path.join(tmpdir(), 'license-util-'))
	await writeJson(path.join(projectDir, 'package.json'), { name: 'project', version: '1.0.0', license: 'MIT' })
	await writeJson(path.join(projectDir, 'companion', 'manifest.json'), { license: 'Apache-2.0' })
	await mkdir(path.join(projectDir, 'src'), { recursive: true })
	await writeFile(path.join(projectDir, 'src', 'main.js'), 'export {}')
	await writeJson(path.join(projectDir, 'node_modules', 'plain', 'package.json'), {
		name: 'plain',
		version: '2.0.0',
		license: 'BSD-3-Clause',
	})
	await mkdir(path.join(projectDir, 'node_modules', 'plain', 'src'), { recursive: true })
	await writeFile(path.join(projectDir, 'node_modules', 'plain', 'src', 'index.js'), 'export {}')
	await writeJson(path.join(projectDir, 'node_modules', '@scope', 'nested', 'package.json'), {
		name: '@scope/nested',
		version: '3.0.0',
		license: 'ISC',
	})
	await mkdir(path.join(projectDir, 'node_modules', '@scope', 'nested', 'lib'), { recursive: true })
	await writeFile(path.join(projectDir, 'node_modules', '@scope', 'nested', 'lib', 'index.js'), 'export {}')
	return projectDir
}

test('normalizes paths without leaking package root', () => {
	assert.equal(normalizeInventoryPath('/repo/node_modules/example/src/index.js', '/repo/node_modules/example'), 'src/index.js')
})

test('collects installed and prebuild package owners without following symlinks', async (t) => {
	const projectDir = await createProjectFixture()
	t.after(() => rm(projectDir, { recursive: true, force: true }))
	const nodeModulesDir = path.join(projectDir, 'pkg', 'module', 'node_modules')

	for (const [name, version] of [
		['external-a', '1.0.0'],
		['transitive-b', '2.0.0'],
		['nested-c', '3.0.0'],
		['@scope/scoped', '4.0.0'],
	]) {
		const packageDir =
			name === 'nested-c'
				? path.join(nodeModulesDir, 'external-a', 'node_modules', name)
				: name === '@scope/scoped'
					? path.join(nodeModulesDir, '@scope', 'scoped')
					: path.join(nodeModulesDir, name)
		await writeJson(path.join(packageDir, 'package.json'), { name, version, license: 'MIT' })
	}
	await mkdir(path.join(nodeModulesDir, '.bin'), { recursive: true })
	await symlink(path.join(nodeModulesDir, 'external-a'), path.join(nodeModulesDir, 'linked-external'), 'dir')
	const outsideDir = await mkdtemp(path.join(tmpdir(), 'license-outside-'))
	t.after(() => rm(outsideDir, { recursive: true, force: true }))
	await writeJson(path.join(outsideDir, 'package.json'), { name: 'outside-link', version: '1.0.0' })
	await symlink(outsideDir, path.join(nodeModulesDir, 'outside-link'), 'dir')

	await writeJson(path.join(projectDir, 'node_modules', 'prebuild-lib', 'package.json'), {
		name: 'prebuild-lib',
		version: '4.0.0',
		license: 'Apache-2.0',
		main: 'index.js',
	})
	await writeFile(path.join(projectDir, 'node_modules', 'prebuild-lib', 'index.js'), 'module.exports = {}')

	const installed = await collectInstalledPackages(nodeModulesDir)
	assert.deepEqual(
		installed.map((pkg) => [pkg.name, pkg.version, pkg.kind, [...pkg.contributingPaths]]),
		[
			['@scope/scoped', '4.0.0', 'external', []],
			['external-a', '1.0.0', 'external', []],
			['nested-c', '3.0.0', 'external', []],
			['transitive-b', '2.0.0', 'external', []],
		],
	)

	const moduleRequire = createRequire(path.join(projectDir, 'package.json'))
	const prebuilds = await collectPrebuildPackages(moduleRequire, ['prebuild-lib', 'prebuild-lib/index.js'])
	assert.deepEqual(prebuilds.map((pkg) => [pkg.name, pkg.kind, [...pkg.contributingPaths]]), [
		['prebuild-lib', 'prebuild', ['prebuilds/ (from prebuild-lib)', 'prebuilds/ (from prebuild-lib/index.js)']],
	])
})

test('collects only positive-byte JavaScript metafile contributors by package', async (t) => {
	const projectDir = await createProjectFixture()
	t.after(() => rm(projectDir, { recursive: true, force: true }))

	const metafile = {
		inputs: {},
		outputs: {
			'pkg/example/main.js': {
				imports: [],
				exports: [],
				entryPoint: 'src/main.js',
				inputs: {
					'src/main.js': { bytesInOutput: 10 },
					'node_modules/plain/src/index.js': { bytesInOutput: 20 },
					'node_modules/@scope/nested/lib/index.js': { bytesInOutput: 30 },
					'node_modules/tree-shaken/index.js': { bytesInOutput: 0 },
				},
			},
			'pkg/example/main.js.map': {
				imports: [],
				exports: [],
				inputs: { 'node_modules/source-map-only/index.js': { bytesInOutput: 100 } },
			},
		},
	}

	const collection = await collectMetafilePackages(projectDir, metafile)
	assert.deepEqual(collection.diagnostics, [])
	assert.deepEqual(
		collection.packages.map((pkg) => ({
			kind: pkg.kind,
			name: pkg.name,
			version: pkg.version,
			declaredLicense: pkg.declaredLicense,
			contributingPaths: [...pkg.contributingPaths],
		})),
		[
			{ kind: 'project', name: 'project', version: '1.0.0', declaredLicense: 'Apache-2.0', contributingPaths: ['src/main.js'] },
			{ kind: 'bundled', name: 'plain', version: '2.0.0', declaredLicense: 'BSD-3-Clause', contributingPaths: ['src/index.js'] },
			{ kind: 'bundled', name: '@scope/nested', version: '3.0.0', declaredLicense: 'ISC', contributingPaths: ['lib/index.js'] },
		],
	)
})

test('attributes symlinked dependencies as dependencies', async (t) => {
	const projectDir = await createProjectFixture()
	t.after(() => rm(projectDir, { recursive: true, force: true }))
	const linkedPackageDir = await mkdtemp(path.join(tmpdir(), 'license-linked-'))
	t.after(() => rm(linkedPackageDir, { recursive: true, force: true }))
	await writeJson(path.join(linkedPackageDir, 'package.json'), { name: 'linked-package', version: '1.0.0', license: 'MIT' })
	await writeFile(path.join(linkedPackageDir, 'index.js'), 'export {}')
	await symlink(linkedPackageDir, path.join(projectDir, 'node_modules', 'linked-package'), 'dir')

	const collection = await collectMetafilePackages(projectDir, {
		inputs: {},
		outputs: {
			'pkg/example/main.js': {
				imports: [],
				exports: [],
				inputs: { 'node_modules/linked-package/index.js': { bytesInOutput: 10 } },
			},
		},
	})
	assert.deepEqual(collection.packages.map((pkg) => [pkg.kind, pkg.name, [...pkg.contributingPaths]]), [
		['bundled', 'linked-package', ['index.js']],
	])
})

test('collects license and NOTICE material with legal comments as fallback', async (t) => {
	const packageDir = await mkdtemp(path.join(tmpdir(), 'legal-material-'))
	t.after(() => rm(packageDir, { recursive: true, force: true }))
	await writeJson(path.join(packageDir, 'package.json'), { name: 'legal-package', version: '1.0.0', license: 'SEE LICENSE IN docs/CUSTOM.txt' })
	await writeFile(path.join(packageDir, 'LICENSE.md'), 'license body\n')
	await writeFile(path.join(packageDir, 'NOTICE.apache'), 'notice body\n')
	await mkdir(path.join(packageDir, 'docs'), { recursive: true })
	await writeFile(path.join(packageDir, 'docs', 'CUSTOM.txt'), 'custom license body\n')
	await mkdir(path.join(packageDir, 'src'), { recursive: true })
	await writeFile(path.join(packageDir, 'src', 'index.js'), '/*! source legal comment */\n// ordinary comment\nexport {}')

	const withLicense = await collectPackageLegalMaterial({
		kind: 'bundled',
		name: 'legal-package',
		version: '1.0.0',
		declaredLicense: 'SEE LICENSE IN docs/CUSTOM.txt',
		packageRoot: packageDir,
		contributingPaths: new Set(['src/index.js']),
	})
	assert.deepEqual(
		withLicense.package.legalTexts.map((text) => [text.role, text.filename, text.content]),
		[
			['license', 'docs/CUSTOM.txt', 'custom license body\n'],
			['license', 'LICENSE.md', 'license body\n'],
			['notice', 'NOTICE.apache', 'notice body\n'],
		],
	)

	await rm(path.join(packageDir, 'LICENSE.md'))
	await rm(path.join(packageDir, 'docs', 'CUSTOM.txt'))
	const fallback = await collectPackageLegalMaterial({
		kind: 'bundled',
		name: 'legal-package',
		version: '1.0.0',
		packageRoot: packageDir,
		contributingPaths: new Set(['src/index.js']),
	})
	assert.equal(fallback.package.legalTexts[0].role, 'notice')
	assert.equal(fallback.package.legalTexts[1].role, 'source-comment')
	assert.equal(fallback.package.legalTexts[1].filename, 'src/index.js')
	assert.match(fallback.package.legalTexts[1].content, /source legal comment/)
	assert.doesNotMatch(fallback.package.legalTexts[1].content, /ordinary comment/)
})

test('reports virtual and outside metafile inputs without treating them as project files', async (t) => {
	const projectDir = await createProjectFixture()
	t.after(() => rm(projectDir, { recursive: true, force: true }))
	const metafile = {
		inputs: {},
		outputs: {
			'pkg/example/main.js': {
				imports: [],
				exports: [],
				inputs: {
					'src/main.js': { bytesInOutput: 10 },
					'<stdin>': { bytesInOutput: 10 },
					'../outside.js': { bytesInOutput: 10 },
				},
			},
		},
	}

	const collection = await collectMetafilePackages(projectDir, metafile)
	assert.deepEqual(collection.packages.map((pkg) => [...pkg.contributingPaths]), [['src/main.js']])
	assert.deepEqual(collection.diagnostics, [
		'Ignoring virtual esbuild input: <stdin>',
		'Ignoring esbuild input outside module directory: ../outside.js',
	])
})
