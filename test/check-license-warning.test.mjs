import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkPackage } from '../dist/scripts/lib/check-util.js'

async function fixture(license, manifest = {}) {
	const cwd = await mkdtemp(path.join(tmpdir(), 'check-license-'))
	await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', main: 'src/main.js', license }))
	await mkdir(path.join(cwd, 'src'), { recursive: true })
	await writeFile(path.join(cwd, 'src', 'main.js'), 'console.log("fixture")')
	await mkdir(path.join(cwd, 'companion'), { recursive: true })
	await writeFile(path.join(cwd, 'companion', 'manifest.json'), JSON.stringify(manifest))
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
		/LICENSE ERROR: Your module is licensed as AGPL-3\.0-only, which is not supported\. We recommend MIT for the widest compatibility, but also accept GPL-2\.0-only or GPL-3\.0-only when necessary\./,
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

test('check uses the package.json license, which the build bakes into the manifest', async (t) => {
	const cwd = await fixture('AGPL-3.0-only', { license: 'MIT' })
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
	assert.match(writes.join(''), /licensed as AGPL-3\.0-only, which is not supported\./)
})

test('check reports a module declaring no license in package.json', async (t) => {
	const cwd = await fixture(undefined, { license: 'MIT' })
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
		/LICENSE ERROR: Your module does not declare a license in package\.json\. We recommend MIT for the widest compatibility, but also accept GPL-2\.0-only or GPL-3\.0-only when necessary\./,
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
		/LICENSE WARNING: Your module is licensed as AGPL-3\.0-only, which is not supported\. We recommend MIT for the widest compatibility, but also accept GPL-2\.0-only or GPL-3\.0-only when necessary\./,
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
