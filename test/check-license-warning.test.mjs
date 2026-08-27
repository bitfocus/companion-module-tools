import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkPackage } from '../dist/scripts/lib/check-util.js'

// The manifest license is what the module is distributed as, package.json licenses the source and must stay MIT
async function fixture(license, packageJsonLicense = 'MIT') {
	const cwd = await mkdtemp(path.join(tmpdir(), 'check-license-'))
	await writeFile(
		path.join(cwd, 'package.json'),
		JSON.stringify({ name: 'fixture', main: 'src/main.js', license: packageJsonLicense }),
	)
	await mkdir(path.join(cwd, 'src'), { recursive: true })
	await writeFile(path.join(cwd, 'src', 'main.js'), 'console.log("fixture")')
	await mkdir(path.join(cwd, 'companion'), { recursive: true })
	await writeFile(path.join(cwd, 'companion', 'manifest.json'), JSON.stringify({ license }))
	return cwd
}

test('check rejects after printing all license issues', async (t) => {
	const cwd = await fixture('AGPL-3.0-only')
	t.after(() => rm(cwd, { recursive: true, force: true }))
	const writes = []
	let validated = false
	await assert.rejects(
		checkPackage({
			cwd,
			validateManifest: () => {
				validated = true
			},
			stderr: { isTTY: false, write: (text) => writes.push(text) },
		}),
		/License validation failed with 1 error/,
	)
	assert.equal(validated, true)
	assert.match(
		writes.join(''),
		/LICENSE ERROR: Your module is published under AGPL-3\.0-only, which is not supported\. We recommend MIT for the widest compatibility, but also accept GPL-2\.0-only or GPL-3\.0-only when necessary\./,
	)
	assert.doesNotMatch(writes.join(''), /Buttons|surface|Companion/)
	assert.doesNotMatch(writes.join(''), /\u001b\[/)
})

test('check accepts a GPL-2.0-only module', async (t) => {
	const cwd = await fixture('GPL-2.0-only')
	t.after(() => rm(cwd, { recursive: true, force: true }))
	const writes = []
	await checkPackage({
		cwd,
		validateManifest: () => {},
		stderr: { isTTY: false, write: (text) => writes.push(text) },
	})
	assert.deepEqual(writes, [])
})

test('check uses the manifest license, not the license of the module source', async (t) => {
	const cwd = await fixture('AGPL-3.0-only', 'MIT')
	t.after(() => rm(cwd, { recursive: true, force: true }))
	const writes = []
	await assert.rejects(
		checkPackage({
			cwd,
			validateManifest: () => {},
			stderr: { isTTY: false, write: (text) => writes.push(text) },
		}),
		/License validation failed with 1 error/,
	)
	assert.match(writes.join(''), /published under AGPL-3\.0-only, which is not supported\./)
})

test('check allows MIT source to be distributed under GPL-3.0-only', async (t) => {
	const cwd = await fixture('GPL-3.0-only', 'MIT')
	t.after(() => rm(cwd, { recursive: true, force: true }))
	const writes = []
	await checkPackage({
		cwd,
		validateManifest: () => {},
		stderr: { isTTY: false, write: (text) => writes.push(text) },
	})
	assert.deepEqual(writes, [])
})

test('check rejects GPL source distributed under an MIT manifest', async (t) => {
	const cwd = await fixture('MIT', 'GPL-3.0-only')
	t.after(() => rm(cwd, { recursive: true, force: true }))
	const writes = []
	await assert.rejects(
		checkPackage({
			cwd,
			validateManifest: () => {},
			stderr: { isTTY: false, write: (text) => writes.push(text) },
		}),
		/License validation failed with 1 error/,
	)
	assert.match(
		writes.join(''),
		/LICENSE ERROR: Your module source is licensed as GPL-3\.0-only in package\.json, but the Companion project requires module source to be MIT so it stays portable\./,
	)
})

test('check falls back to the package.json license when the manifest declares none', async (t) => {
	const cwd = await fixture(undefined, 'MIT')
	t.after(() => rm(cwd, { recursive: true, force: true }))
	const writes = []
	await checkPackage({
		cwd,
		validateManifest: () => {},
		stderr: { isTTY: false, write: (text) => writes.push(text) },
	})
	assert.deepEqual(writes, [])
})

test('check reports a module declaring no license at all', async (t) => {
	const cwd = await fixture(undefined, null) // null, as an omitted argument takes the MIT default
	t.after(() => rm(cwd, { recursive: true, force: true }))
	const writes = []
	await assert.rejects(
		checkPackage({
			cwd,
			validateManifest: () => {},
			stderr: { isTTY: false, write: (text) => writes.push(text) },
		}),
		/License validation failed with 2 errors/,
	)
	assert.match(writes.join(''), /LICENSE ERROR: Your module does not declare a license in companion\/manifest\.json\./)
	assert.match(
		writes.join(''),
		/LICENSE ERROR: Your module source does not declare a license in package\.json, but the Companion project requires module source to be MIT so it stays portable\./,
	)
})

test('check ignore option warns and resolves', async (t) => {
	const cwd = await fixture('AGPL-3.0-only')
	t.after(() => rm(cwd, { recursive: true, force: true }))
	const writes = []
	await checkPackage({
		cwd,
		ignoreLicenseRules: true,
		validateManifest: () => {},
		stderr: { isTTY: false, write: (text) => writes.push(text) },
	})
	assert.match(
		writes.join(''),
		/LICENSE WARNING: Your module is published under AGPL-3\.0-only, which is not supported\. We recommend MIT for the widest compatibility, but also accept GPL-2\.0-only or GPL-3\.0-only when necessary\./,
	)
	assert.match(writes.join(''), /ignored 1 error/)
	assert.doesNotMatch(writes.join(''), /\u001b\[/)
})

test('check stops before analysis when manifest validation fails', async (t) => {
	const cwd = await fixture('AGPL-3.0-only')
	t.after(() => rm(cwd, { recursive: true, force: true }))
	await assert.rejects(
		checkPackage({
			cwd,
			validateManifest: () => {
				throw new Error('invalid manifest')
			},
		}),
		/invalid manifest/,
	)
})
