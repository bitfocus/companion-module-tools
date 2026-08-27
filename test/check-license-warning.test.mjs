import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkPackage } from '../dist/scripts/lib/check-util.js'

async function fixture(license) {
	const cwd = await mkdtemp(path.join(tmpdir(), 'check-license-'))
	await writeFile(
		path.join(cwd, 'package.json'),
		JSON.stringify({ name: 'fixture', main: 'src/main.js', license: 'MIT' }),
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
	assert.match(writes.join(''), /LICENSE ERROR: Your module must be licensed under MIT; found AGPL-3\.0-only\./)
	assert.doesNotMatch(writes.join(''), /Buttons|surface|Companion/)
	assert.doesNotMatch(writes.join(''), /\u001b\[/)
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
	assert.match(writes.join(''), /LICENSE WARNING: Your module must be licensed under MIT; found AGPL-3\.0-only\./)
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
