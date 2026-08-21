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

for (const moduleType of ['connection', 'surface']) {
	test(`check prints non-failing ${moduleType} warning`, async (t) => {
		const cwd = await fixture('AGPL-3.0-only')
		t.after(() => rm(cwd, { recursive: true, force: true }))
		const writes = []
		let validated = false
		await checkPackage({
			moduleType,
			cwd,
			validateManifest: () => {
				validated = true
			},
			stderr: { isTTY: false, write: (text) => writes.push(text) },
		})
		assert.equal(validated, true)
		assert.match(writes.join(''), /Your module must be licensed under MIT; found AGPL-3\.0-only\./)
		assert.doesNotMatch(writes.join(''), /Buttons|surface|Companion/)
		assert.doesNotMatch(writes.join(''), /\u001b\[/)
	})
}

test('check stops before analysis when manifest validation fails', async (t) => {
	const cwd = await fixture('AGPL-3.0-only')
	t.after(() => rm(cwd, { recursive: true, force: true }))
	await assert.rejects(
		checkPackage({
			moduleType: 'connection',
			cwd,
			validateManifest: () => {
				throw new Error('invalid manifest')
			},
		}),
		/invalid manifest/,
	)
})
