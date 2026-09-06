import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
	NO_LICENSE_OVERRIDES,
	collectInstalledPackages,
	collectPackagesFromInputPaths,
	createLegalInventory,
	createLicensePolicyIssues,
	enforceLicensePolicy,
	LicensePolicyError,
} from '../dist/license/index.js'

const APPLICATION_POLICY = {
	subject: 'application',
	distributionLicenseLocation: 'package.json',
	requiredSourceLicense: undefined,
	externaliseAdvice: undefined,
	helpMessage: 'Ask the maintainers.',
}

async function writeJson(filePath, value) {
	await mkdir(path.dirname(filePath), { recursive: true })
	await writeFile(filePath, JSON.stringify(value))
}

/** A workspace root holding node_modules, with two workspaces which both contribute code to one bundle */
async function createMonorepoFixture() {
	const rootDir = await mkdtemp(path.join(tmpdir(), 'license-engine-'))
	await writeJson(path.join(rootDir, 'package.json'), { name: 'app', version: '1.0.0', license: 'MIT' })
	await writeFile(path.join(rootDir, 'LICENSE'), 'App license text')
	for (const workspace of ['backend', 'shared']) {
		await mkdir(path.join(rootDir, workspace, 'lib'), { recursive: true })
		await writeFile(path.join(rootDir, workspace, 'lib', 'main.js'), 'export {}')
	}
	await writeJson(path.join(rootDir, 'node_modules', 'hoisted', 'package.json'), {
		name: 'hoisted',
		version: '2.0.0',
		license: 'BSD-3-Clause',
	})
	await writeFile(path.join(rootDir, 'node_modules', 'hoisted', 'LICENSE'), 'Hoisted license text')
	await writeJson(path.join(rootDir, 'node_modules', 'undeclared', 'package.json'), {
		name: 'undeclared',
		version: '3.0.0',
	})
	return rootDir
}

const monorepoIdentity = (rootDir) => ({
	projectRoots: [rootDir],
	packageRoot: rootDir,
	name: undefined,
	distributionLicense: 'MIT',
})

test('attributes hoisted dependencies and every workspace of a monorepo', async (t) => {
	const rootDir = await createMonorepoFixture()
	t.after(() => rm(rootDir, { recursive: true, force: true }))

	const collection = await collectPackagesFromInputPaths(
		[
			path.join(rootDir, 'backend', 'lib', 'main.js'),
			path.join(rootDir, 'shared', 'lib', 'main.js'),
			path.join(rootDir, 'node_modules', 'hoisted', 'index.js'),
		],
		monorepoIdentity(rootDir),
		NO_LICENSE_OVERRIDES,
	)

	assert.deepEqual(collection.diagnostics, [])
	assert.deepEqual(
		collection.packages.map((pkg) => [pkg.kind, pkg.name, pkg.declaredLicense, [...pkg.contributingPaths].sort()]),
		[
			['project', 'app', 'MIT', ['backend/lib/main.js', 'shared/lib/main.js']],
			['bundled', 'hoisted', 'BSD-3-Clause', ['index.js']],
		],
	)
})

test('reports inputs from outside every project root rather than attributing them', async (t) => {
	const rootDir = await createMonorepoFixture()
	t.after(() => rm(rootDir, { recursive: true, force: true }))

	const outsidePath = path.resolve(rootDir, '..', 'elsewhere.js')
	const collection = await collectPackagesFromInputPaths([outsidePath], monorepoIdentity(rootDir), NO_LICENSE_OVERRIDES)

	assert.deepEqual(collection.packages, [])
	assert.deepEqual(collection.diagnostics, [`Ignoring bundle input outside the project: ${outsidePath}`])
})

test('applies the caller supplied known licenses to packages declaring none', async (t) => {
	const rootDir = await createMonorepoFixture()
	t.after(() => rm(rootDir, { recursive: true, force: true }))

	const overrides = { knownPackageLicenses: { 'undeclared@3.0.0': 'ISC' }, correctedPackageLicenses: {} }
	const installed = await collectInstalledPackages(path.join(rootDir, 'node_modules'), overrides)
	const undeclared = installed.find((pkg) => pkg.name === 'undeclared')

	assert.equal(undeclared.declaredLicense, 'ISC')
	// A different consumer, with no overrides, sees the package exactly as it declares itself
	const plain = await collectInstalledPackages(path.join(rootDir, 'node_modules'), NO_LICENSE_OVERRIDES)
	assert.equal(plain.find((pkg) => pkg.name === 'undeclared').declaredLicense, undefined)
})

test('applies the caller supplied corrections only to unparseable declarations', async () => {
	const dependency = (name, version, declaredLicense) => ({
		kind: 'bundled',
		name,
		version,
		declaredLicense,
		packageRoot: `/${name}`,
		contributingPaths: new Set(),
		legalTexts: [],
	})
	const project = {
		...dependency('app', '1.0.0', 'MIT'),
		kind: 'project',
		sourceLicense: 'MIT',
	}
	const overrides = {
		knownPackageLicenses: {},
		// The second entry would launder a real license, were corrections ever consulted for a valid declaration
		correctedPackageLicenses: { 'legacy@1.0.0': 'BSD-3-Clause', 'copyleft@1.0.0': 'MIT' },
	}

	const issues = createLicensePolicyIssues(
		{
			diagnostics: [],
			packages: [project, dependency('legacy', '1.0.0', 'BSD'), dependency('copyleft', '1.0.0', 'GPL-3.0-only')],
		},
		APPLICATION_POLICY,
		overrides,
	)

	assert.deepEqual(
		issues.map((issue) => issue.packageName),
		['copyleft'],
	)
})

test('reports no source license issue when the project has no separate source license rule', async (t) => {
	const rootDir = await createMonorepoFixture()
	t.after(() => rm(rootDir, { recursive: true, force: true }))

	const collection = await collectPackagesFromInputPaths(
		[path.join(rootDir, 'backend', 'lib', 'main.js'), path.join(rootDir, 'node_modules', 'undeclared', 'index.js')],
		monorepoIdentity(rootDir),
		NO_LICENSE_OVERRIDES,
	)
	const inventory = await createLegalInventory(collection.packages)

	assert.deepEqual(
		createLicensePolicyIssues(inventory, APPLICATION_POLICY, NO_LICENSE_OVERRIDES).map((issue) => issue.message),
		['Dependency undeclared@3.0.0 has no declared license.'],
	)
})

test('a policy with no way to externalise reports such a dependency as incompatible', async () => {
	const lgpl = {
		kind: 'bundled',
		name: 'lgpl-dep',
		version: '1.0.0',
		declaredLicense: 'LGPL-3.0-only',
		packageRoot: '/lgpl-dep',
		contributingPaths: new Set(),
		legalTexts: [],
	}
	const project = { ...lgpl, kind: 'project', name: 'app', declaredLicense: 'MIT', sourceLicense: 'MIT' }
	const stderr = {
		output: '',
		write(text) {
			this.output += text
		},
	}

	assert.throws(
		() =>
			enforceLicensePolicy({ diagnostics: [], packages: [project, lgpl] }, APPLICATION_POLICY, NO_LICENSE_OVERRIDES, {
				stderr,
			}),
		(error) => error instanceof LicensePolicyError,
	)
	assert.match(stderr.output, /is not compatible with the MIT license policy/)
	assert.doesNotMatch(stderr.output, /external dependency/)
	assert.match(stderr.output, /Ask the maintainers\./)
})

test('names the project as the built artifact ships rather than as its package.json does', async (t) => {
	const rootDir = await createMonorepoFixture()
	t.after(() => rm(rootDir, { recursive: true, force: true }))

	const collection = await collectPackagesFromInputPaths(
		[path.join(rootDir, 'backend', 'lib', 'main.js')],
		{ ...monorepoIdentity(rootDir), name: 'shipped-name' },
		NO_LICENSE_OVERRIDES,
	)

	assert.deepEqual(
		collection.packages.map((pkg) => [pkg.name, pkg.version]),
		[['shipped-name', '1.0.0']],
	)
})
