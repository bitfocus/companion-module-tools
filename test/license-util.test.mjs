import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { KNOWN_PACKAGE_LICENSES } from '../scripts/lib/known-package-licenses.js'
import {
	analyzeShippedLegalInventory,
	collectProductionPackages,
	readExternalNames,
	collectInstalledPackages,
	collectPackageLegalMaterial,
	createLegalInventory,
	normalizeInventoryPath,
	normalizeRepositoryUrl,
	normalizeLegalText,
	renderLicenseFile,
	renderNoticeFile,
	writeLegalArtifacts,
} from '../scripts/lib/license-util.js'

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
	await mkdir(path.join(projectDir, 'node_modules', 'plain', 'prebuilds', 'linux-x64'), { recursive: true })
	await writeFile(path.join(projectDir, 'node_modules', 'plain', 'prebuilds', 'linux-x64', 'addon.node'), '')
	await writeJson(path.join(projectDir, 'node_modules', '@scope', 'nested', 'package.json'), {
		name: '@scope/nested',
		version: '3.0.0',
		license: 'ISC',
	})
	await mkdir(path.join(projectDir, 'node_modules', '@scope', 'nested', 'lib'), { recursive: true })
	await writeFile(path.join(projectDir, 'node_modules', '@scope', 'nested', 'lib', 'index.js'), 'export {}')
	return projectDir
}

test('reads the deprecated npm license fields', async (t) => {
	const nodeModulesDir = await mkdtemp(path.join(tmpdir(), 'license-deprecated-'))
	t.after(() => rm(nodeModulesDir, { recursive: true, force: true }))
	// npm replaced these with a plain SPDX string, but packages published before that are still installed today
	await writeJson(path.join(nodeModulesDir, 'array-form', 'package.json'), {
		name: 'array-form',
		version: '1.0.0',
		licenses: [{ type: 'MIT', url: 'http://example.com/MIT' }],
	})
	await writeJson(path.join(nodeModulesDir, 'choice-form', 'package.json'), {
		name: 'choice-form',
		version: '1.0.0',
		licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }],
	})
	await writeJson(path.join(nodeModulesDir, 'object-form', 'package.json'), {
		name: 'object-form',
		version: '1.0.0',
		license: { type: 'ISC', url: 'http://example.com/ISC' },
	})
	await writeJson(path.join(nodeModulesDir, 'current-form', 'package.json'), {
		name: 'current-form',
		version: '1.0.0',
		license: 'BSD-3-Clause',
		licenses: [{ type: 'GPL-3.0-only' }],
	})
	await writeJson(path.join(nodeModulesDir, 'unusable-form', 'package.json'), {
		name: 'unusable-form',
		version: '1.0.0',
		licenses: [{ url: 'http://example.com/mystery' }],
	})

	const packages = await collectInstalledPackages(nodeModulesDir)
	assert.deepEqual(
		packages.map((pkg) => [pkg.name, pkg.declaredLicense]),
		[
			['array-form', 'MIT'],
			['choice-form', '(MIT OR Apache-2.0)'],
			['current-form', 'BSD-3-Clause'],
			['object-form', 'ISC'],
			['unusable-form', undefined],
		],
	)
})

test('falls back to confirmed licenses for packages which declare none', async (t) => {
	const nodeModulesDir = await mkdtemp(path.join(tmpdir(), 'license-known-'))
	t.after(() => rm(nodeModulesDir, { recursive: true, force: true }))
	const [name, version] = Object.keys(KNOWN_PACKAGE_LICENSES)[0].split('@')
	const known = KNOWN_PACKAGE_LICENSES[`${name}@${version}`]

	await writeJson(path.join(nodeModulesDir, 'confirmed', 'package.json'), { name, version })
	// A declared license always wins, so an entry can never hide what a package says about itself
	await writeJson(path.join(nodeModulesDir, 'declared', 'package.json'), { name, version, license: 'GPL-3.0-only' })
	// Entries are for one exact version, as a later release can change license
	await writeJson(path.join(nodeModulesDir, 'other-version', 'package.json'), { name, version: `${version}-other` })

	const packages = await collectInstalledPackages(nodeModulesDir)
	assert.deepEqual(
		packages.map((pkg) => [pkg.packageRoot.split(path.sep).pop(), pkg.declaredLicense]),
		[
			['confirmed', known],
			['declared', 'GPL-3.0-only'],
			['other-version', undefined],
		],
	)
})

test('normalizes repository declarations into a source url', () => {
	const url = 'https://github.com/example/repo'
	for (const repository of [
		url,
		`${url}.git`,
		{ type: 'git', url: `git+${url}.git` },
		{ type: 'git', url: 'git://github.com/example/repo.git' },
		{ type: 'git', url: 'ssh://git@github.com/example/repo.git' },
		{ type: 'git', url: 'git@github.com:example/repo.git' },
		'example/repo',
		'github:example/repo',
	]) {
		assert.equal(normalizeRepositoryUrl({ repository }), url)
	}
	assert.equal(normalizeRepositoryUrl({ repository: 'gitlab:example/repo' }), 'https://gitlab.com/example/repo')
	assert.equal(normalizeRepositoryUrl({ repository: 'bitbucket:example/repo' }), 'https://bitbucket.org/example/repo')
	// Falls back to the homepage, and never emits a url which cannot be followed
	assert.equal(normalizeRepositoryUrl({ homepage: 'https://example.com/pkg' }), 'https://example.com/pkg')
	assert.equal(normalizeRepositoryUrl({ repository: { url: 'not a url' }, homepage: url }), url)
	assert.equal(normalizeRepositoryUrl({}), undefined)
	assert.equal(normalizeRepositoryUrl({ repository: 42, homepage: 42 }), undefined)
	assert.equal(normalizeRepositoryUrl({ repository: 'file:///local/repo' }), undefined)
})

test('normalizes paths without leaking package root', () => {
	assert.equal(
		normalizeInventoryPath('/repo/node_modules/example/src/index.js', '/repo/node_modules/example'),
		'src/index.js',
	)
})

test('normalizes legal text before hashing and rendering', async (t) => {
	assert.equal(normalizeLegalText('\r\n  MIT text\r\n\r\n'), 'MIT text')
	assert.equal(normalizeLegalText('\tline one\r\n\r\nline two  '), 'line one\n\nline two')
	assert.equal(normalizeLegalText('line one\n  indented line\nline three'), 'line one\n  indented line\nline three')

	const firstDir = await mkdtemp(path.join(tmpdir(), 'legal-normalize-a-'))
	const secondDir = await mkdtemp(path.join(tmpdir(), 'legal-normalize-b-'))
	t.after(() =>
		Promise.all([rm(firstDir, { recursive: true, force: true }), rm(secondDir, { recursive: true, force: true })]),
	)
	for (const [packageDir, body] of [
		[firstDir, '\r\n shared text \r\n'],
		[secondDir, 'shared text\n'],
	]) {
		await writeJson(path.join(packageDir, 'package.json'), { name: path.basename(packageDir), license: 'MIT' })
		await writeFile(path.join(packageDir, 'LICENSE'), body)
	}
	const first = await collectPackageLegalMaterial({
		kind: 'bundled',
		name: 'a',
		packageRoot: firstDir,
		contributingPaths: new Set(),
	})
	const second = await collectPackageLegalMaterial({
		kind: 'bundled',
		name: 'b',
		packageRoot: secondDir,
		contributingPaths: new Set(),
	})
	assert.equal(first.package.legalTexts[0].content, 'shared text')
	assert.equal(first.package.legalTexts[0].sha256, second.package.legalTexts[0].sha256)
})

test('collects installed package owners without following symlinks', async (t) => {
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
})

test('builds one legal inventory from duplicate shipped package records', async (t) => {
	const packageDir = await mkdtemp(path.join(tmpdir(), 'legal-inventory-'))
	t.after(() => rm(packageDir, { recursive: true, force: true }))
	await writeJson(path.join(packageDir, 'package.json'), { name: 'merged-package', version: '1.0.0', license: 'MIT' })
	await writeFile(path.join(packageDir, 'LICENSE'), 'merged license\n')
	const inventory = await createLegalInventory([
		{
			kind: 'bundled',
			name: 'merged-package',
			version: '1.0.0',
			declaredLicense: 'MIT',
			packageRoot: packageDir,
			contributingPaths: new Set(['src/a.js']),
		},
		{
			kind: 'external',
			name: 'merged-package',
			version: '1.0.0',
			declaredLicense: 'MIT',
			packageRoot: packageDir,
			contributingPaths: new Set(),
		},
	])
	assert.deepEqual(
		inventory.packages.map((pkg) => [pkg.kind, [...pkg.contributingPaths], pkg.legalTexts.length]),
		[['bundled', ['src/a.js'], 1]],
	)
})

test('renders deterministic aggregate license and NOTICE artifacts', async (t) => {
	const inventory = {
		diagnostics: [],
		packages: [
			{
				kind: 'bundled',
				name: 'z-dependency',
				version: '2.0.0',
				declaredLicense: 'MIT',
				packageRoot: '/secret/z',
				contributingPaths: new Set(['lib/z.js']),
				legalTexts: [{ role: 'license', filename: 'LICENSE', content: 'shared license\n', sha256: 'shared' }],
			},
			{
				kind: 'project',
				name: 'project',
				version: '1.0.0',
				declaredLicense: 'Apache-2.0',
				packageRoot: '/secret/project',
				contributingPaths: new Set(['src/main.js']),
				legalTexts: [
					{ role: 'license', filename: 'LICENSE', content: 'project license\n', sha256: 'project' },
					{ role: 'notice', filename: 'NOTICE', content: 'project notice\n', sha256: 'notice' },
				],
			},
			{
				kind: 'bundled',
				name: 'a-dependency',
				version: '1.0.0',
				declaredLicense: 'MIT',
				repositoryUrl: 'https://github.com/example/a-dependency',
				packageRoot: '/secret/a',
				contributingPaths: new Set(['index.js']),
				legalTexts: [
					{ role: 'license', filename: 'COPYING', content: 'shared license\n', sha256: 'shared' },
					{ role: 'source-comment', filename: 'index.js', content: 'shared license\n', sha256: 'shared' },
				],
			},
		],
	}
	const separator = '-'.repeat(80)
	const license = renderLicenseFile(inventory)
	assert.equal(
		license,
		`Packages: project@1.0.0 — Apache-2.0\n${separator}\nproject license\n\nPackages: a-dependency@1.0.0 — MIT (https://github.com/example/a-dependency), z-dependency@2.0.0 — MIT\n${separator}\nshared license\n`,
	)
	assert.equal(renderNoticeFile(inventory), `Packages: project@1.0.0 — Apache-2.0\n${separator}\nproject notice\n`)
	assert.doesNotMatch(license, /Source|Applies to|Package:|BEGIN|END|\/secret/)
	assert.equal(renderLicenseFile({ packages: [], diagnostics: [] }), '')
	assert.equal(renderNoticeFile({ packages: [], diagnostics: [] }), undefined)

	const outputDir = await mkdtemp(path.join(tmpdir(), 'legal-artifacts-'))
	t.after(() => rm(outputDir, { recursive: true, force: true }))
	await writeLegalArtifacts(outputDir, inventory)
	assert.equal(await readFile(path.join(outputDir, 'LICENSE'), 'utf8'), license)
	assert.match(await readFile(path.join(outputDir, 'NOTICE'), 'utf8'), /project notice/)
	await writeLegalArtifacts(outputDir, {
		...inventory,
		packages: inventory.packages.map((pkg) => ({
			...pkg,
			legalTexts: pkg.legalTexts.filter((text) => text.role !== 'notice'),
		})),
	})
	await assert.rejects(readFile(path.join(outputDir, 'NOTICE')))
})

test('rejects SEE LICENSE IN symlinks escaping package root', async (t) => {
	const packageDir = await mkdtemp(path.join(tmpdir(), 'legal-symlink-'))
	const outsideDir = await mkdtemp(path.join(tmpdir(), 'legal-outside-'))
	t.after(() =>
		Promise.all([rm(packageDir, { recursive: true, force: true }), rm(outsideDir, { recursive: true, force: true })]),
	)
	await writeJson(path.join(packageDir, 'package.json'), {
		name: 'symlink-package',
		license: 'SEE LICENSE IN docs/LEAK',
	})
	await writeFile(path.join(outsideDir, 'LICENSE'), 'outside legal text\n')
	await mkdir(path.join(packageDir, 'docs'), { recursive: true })
	await symlink(path.join(outsideDir, 'LICENSE'), path.join(packageDir, 'docs', 'LEAK'))

	const material = await collectPackageLegalMaterial({
		kind: 'bundled',
		name: 'symlink-package',
		packageRoot: packageDir,
		contributingPaths: new Set(),
		declaredLicense: 'SEE LICENSE IN docs/LEAK',
	})
	assert.deepEqual(material.package.legalTexts, [])
	// Unlike main, nothing can be recovered from the bundled sources, so the package is also reported as having none
	assert.deepEqual(material.diagnostics, [
		'Ignoring unreadable, binary, or oversized legal file: docs/LEAK',
		'No license file found in package: symlink-package',
	])
})

// main scrapes `/*! ... */` banners out of the bundled sources with esbuild when a package ships no license file.
// Neither esbuild nor the bundled file list is available here, so those packages are reported instead.
test('collects license and NOTICE material, reporting packages which ship no license file', async (t) => {
	const packageDir = await mkdtemp(path.join(tmpdir(), 'legal-material-'))
	t.after(() => rm(packageDir, { recursive: true, force: true }))
	await writeJson(path.join(packageDir, 'package.json'), {
		name: 'legal-package',
		version: '1.0.0',
		license: 'SEE LICENSE IN docs/CUSTOM.txt',
	})
	await writeFile(path.join(packageDir, 'LICENSE.md'), 'license body\n')
	await writeFile(path.join(packageDir, 'NOTICE.apache'), 'notice body\n')
	await mkdir(path.join(packageDir, 'docs'), { recursive: true })
	await writeFile(path.join(packageDir, 'docs', 'CUSTOM.txt'), 'custom license body\n')

	const withLicense = await collectPackageLegalMaterial({
		kind: 'bundled',
		name: 'legal-package',
		version: '1.0.0',
		declaredLicense: 'SEE LICENSE IN docs/CUSTOM.txt',
		packageRoot: packageDir,
		contributingPaths: new Set(),
	})
	assert.deepEqual(
		withLicense.package.legalTexts.map((text) => [text.role, text.filename, text.content]),
		[
			['license', 'docs/CUSTOM.txt', 'custom license body'],
			['license', 'LICENSE.md', 'license body'],
			['notice', 'NOTICE.apache', 'notice body'],
		],
	)
	assert.deepEqual(withLicense.diagnostics, [])

	// A NOTICE alone is not a license, so the package is still reported as shipping none
	await rm(path.join(packageDir, 'LICENSE.md'))
	await rm(path.join(packageDir, 'docs', 'CUSTOM.txt'))
	const fallback = await collectPackageLegalMaterial({
		kind: 'bundled',
		name: 'legal-package',
		version: '1.0.0',
		packageRoot: packageDir,
		contributingPaths: new Set(),
	})
	assert.deepEqual(
		fallback.package.legalTexts.map((text) => [text.role, text.filename]),
		[['notice', 'NOTICE.apache']],
	)
	assert.deepEqual(fallback.diagnostics, ['No license file found in package: legal-package@1.0.0'])
})

async function createDependencyFixture() {
	const workspaceDir = await mkdtemp(path.join(tmpdir(), 'license-deps-'))
	const moduleDir = path.join(workspaceDir, 'module')
	await writeJson(path.join(moduleDir, 'package.json'), {
		name: 'project',
		version: '1.0.0',
		license: 'MIT',
		dependencies: { direct: '^1.0.0' },
		devDependencies: { 'dev-only': '^1.0.0' },
		optionalDependencies: { 'absent-optional': '^1.0.0' },
	})
	await writeJson(path.join(moduleDir, 'companion', 'manifest.json'), { license: 'GPL-3.0-only' })

	// direct depends on transitive, and pins its own copy of shared which shadows the hoisted one
	await writeJson(path.join(moduleDir, 'node_modules', 'direct', 'package.json'), {
		name: 'direct',
		version: '1.0.0',
		license: 'ISC',
		dependencies: { transitive: '^1.0.0', shared: '^1.0.0' },
	})
	await writeJson(path.join(moduleDir, 'node_modules', 'direct', 'node_modules', 'shared', 'package.json'), {
		name: 'shared',
		version: '1.0.0',
		license: 'Apache-2.0',
	})
	// transitive is only reachable through direct, and depends back on direct to prove cycles terminate
	await writeJson(path.join(moduleDir, 'node_modules', 'transitive', 'package.json'), {
		name: 'transitive',
		version: '1.0.0',
		license: 'BSD-3-Clause',
		dependencies: { direct: '^1.0.0', shared: '^1.0.0' },
	})
	// devDependencies are never walked, at any level
	await writeJson(path.join(moduleDir, 'node_modules', 'dev-only', 'package.json'), {
		name: 'dev-only',
		version: '1.0.0',
		license: 'GPL-3.0-only',
	})
	// Hoisted above the module directory, the way a yarn workspace installs a shared dependency
	await writeJson(path.join(workspaceDir, 'node_modules', 'shared', 'package.json'), {
		name: 'shared',
		version: '2.0.0',
		license: 'MPL-2.0',
	})
	return { workspaceDir, moduleDir }
}

test('walks the production dependency tree, resolving hoisted and shadowed packages', async (t) => {
	const { workspaceDir, moduleDir } = await createDependencyFixture()
	t.after(() => rm(workspaceDir, { recursive: true, force: true }))

	const collection = await collectProductionPackages(moduleDir)
	assert.deepEqual(
		collection.packages.map((pkg) => [pkg.kind, pkg.name, pkg.version, pkg.declaredLicense]).sort(),
		[
			['bundled', 'direct', '1.0.0', 'ISC'],
			['bundled', 'shared', '1.0.0', 'Apache-2.0'],
			['bundled', 'shared', '2.0.0', 'MPL-2.0'],
			['bundled', 'transitive', '1.0.0', 'BSD-3-Clause'],
			['project', 'project', '1.0.0', 'GPL-3.0-only'],
		].sort(),
	)
	// A missing optional dependency is not a problem, so it is not reported
	assert.deepEqual(collection.diagnostics, [])
})

test('never walks devDependencies', async (t) => {
	const { workspaceDir, moduleDir } = await createDependencyFixture()
	t.after(() => rm(workspaceDir, { recursive: true, force: true }))

	const collection = await collectProductionPackages(moduleDir)
	assert.equal(
		collection.packages.find((pkg) => pkg.name === 'dev-only'),
		undefined,
	)
})

test('separates the distributed manifest license from the package.json source license', async (t) => {
	const { workspaceDir, moduleDir } = await createDependencyFixture()
	t.after(() => rm(workspaceDir, { recursive: true, force: true }))

	const project = (await collectProductionPackages(moduleDir)).packages.find((pkg) => pkg.kind === 'project')
	assert.equal(project.declaredLicense, 'GPL-3.0-only')
	assert.equal(project.sourceLicense, 'MIT')

	// Without a readable manifest the package.json license is what the module is distributed under
	await rm(path.join(moduleDir, 'companion'), { recursive: true, force: true })
	const withoutManifest = (await collectProductionPackages(moduleDir)).packages.find((pkg) => pkg.kind === 'project')
	assert.equal(withoutManifest.declaredLicense, 'MIT')
	assert.equal(withoutManifest.sourceLicense, 'MIT')
})

test('reports a declared dependency which is not installed', async (t) => {
	const { workspaceDir, moduleDir } = await createDependencyFixture()
	t.after(() => rm(workspaceDir, { recursive: true, force: true }))
	await rm(path.join(moduleDir, 'node_modules', 'transitive'), { recursive: true, force: true })

	const collection = await collectProductionPackages(moduleDir)
	assert.deepEqual(collection.diagnostics, [
		'Ignoring dependency which is not installed: transitive (required by direct)',
	])
	assert.equal(
		collection.packages.find((pkg) => pkg.name === 'transitive'),
		undefined,
	)
})

test('builds a whole inventory from the dependency tree', async (t) => {
	const { workspaceDir, moduleDir } = await createDependencyFixture()
	t.after(() => rm(workspaceDir, { recursive: true, force: true }))
	await writeFile(path.join(moduleDir, 'LICENSE'), 'project license\n')
	await writeFile(path.join(moduleDir, 'node_modules', 'direct', 'LICENSE'), 'direct license\n')

	const inventory = await analyzeShippedLegalInventory(moduleDir)
	assert.deepEqual(inventory.packages.map((pkg) => pkg.name).sort(), [
		'direct',
		'project',
		'shared',
		'shared',
		'transitive',
	])
	assert.match(renderLicenseFile(inventory), /project license/)
	assert.match(renderLicenseFile(inventory), /direct license/)
	// The packages which ship no license file at all are reported rather than silently contributing nothing
	assert.deepEqual(inventory.diagnostics.filter((d) => d.startsWith('No license file')).length, 3)
})

async function createExternalsFixture() {
	const workspaceDir = await mkdtemp(path.join(tmpdir(), 'license-externals-'))
	const moduleDir = path.join(workspaceDir, 'module')
	await writeJson(path.join(moduleDir, 'package.json'), {
		name: 'project',
		version: '1.0.0',
		license: 'MIT',
		dependencies: { 'native-lib': '^1.0.0', bundled: '^1.0.0' },
	})
	await writeJson(path.join(moduleDir, 'companion', 'manifest.json'), { license: 'MIT' })
	// native-lib is externalised, so it and its own dependencies ship beside the bundle
	await writeJson(path.join(moduleDir, 'node_modules', 'native-lib', 'package.json'), {
		name: 'native-lib',
		version: '1.0.0',
		license: 'LGPL-3.0-or-later',
		dependencies: { 'native-dep': '^1.0.0', shared: '^1.0.0' },
	})
	await writeJson(path.join(moduleDir, 'node_modules', 'native-dep', 'package.json'), {
		name: 'native-dep',
		version: '1.0.0',
		license: 'MIT',
	})
	// shared is reached both through the external and through bundled code, so it is bundled
	await writeJson(path.join(moduleDir, 'node_modules', 'bundled', 'package.json'), {
		name: 'bundled',
		version: '1.0.0',
		license: 'MIT',
		dependencies: { shared: '^1.0.0' },
	})
	await writeJson(path.join(moduleDir, 'node_modules', 'shared', 'package.json'), {
		name: 'shared',
		version: '1.0.0',
		license: 'MIT',
	})
	return { workspaceDir, moduleDir }
}

test('classifies externals and their dependencies as shipping beside the bundle', async (t) => {
	const { workspaceDir, moduleDir } = await createExternalsFixture()
	t.after(() => rm(workspaceDir, { recursive: true, force: true }))

	const collection = await collectProductionPackages(moduleDir, ['native-lib'])
	assert.deepEqual(
		collection.packages.map((pkg) => [pkg.name, pkg.kind]).sort(),
		[
			['bundled', 'bundled'],
			['native-dep', 'external'],
			['native-lib', 'external'],
			['project', 'project'],
			// Reachable without crossing an external, so it really is built into the bundle
			['shared', 'bundled'],
		].sort(),
	)
})

test('treats every package as bundled when nothing is declared external', async (t) => {
	const { workspaceDir, moduleDir } = await createExternalsFixture()
	t.after(() => rm(workspaceDir, { recursive: true, force: true }))

	const collection = await collectProductionPackages(moduleDir)
	assert.deepEqual(
		collection.packages.filter((pkg) => pkg.kind === 'external'),
		[],
	)
	assert.equal(collection.packages.length, 5)
})

test('reads the externals a module declares in build-config.cjs', async (t) => {
	const { workspaceDir, moduleDir } = await createExternalsFixture()
	t.after(() => rm(workspaceDir, { recursive: true, force: true }))

	assert.deepEqual(readExternalNames(moduleDir), [], 'no build-config.cjs')
	await writeFile(
		path.join(moduleDir, 'build-config.cjs'),
		"module.exports = { externals: [{ 'native-lib': 'commonjs2 native-lib' }] }\n",
	)
	assert.deepEqual(readExternalNames(moduleDir), ['native-lib'])

	// An LGPL external is only acceptable because the inventory knows it is not bundled
	const inventory = await analyzeShippedLegalInventory(moduleDir)
	assert.equal(inventory.packages.find((pkg) => pkg.name === 'native-lib').kind, 'external')
})
