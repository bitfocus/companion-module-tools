import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createEsbuildOptions, loadModuleBuildDefinition } from '../dist/scripts/lib/bundle-util.js'

test('shares entrypoints and externals for build and analysis', async (t) => {
	const moduleDir = await mkdtemp(path.join(tmpdir(), 'bundle-util-'))
	t.after(() => rm(moduleDir, { recursive: true, force: true }))
	await writeFile(path.join(moduleDir, 'package.json'), JSON.stringify({ main: 'src/main.ts' }))
	await mkdir(path.join(moduleDir, 'src'), { recursive: true })
	await writeFile(path.join(moduleDir, 'src', 'main.ts'), 'export {}')
	await writeFile(
		path.join(moduleDir, 'build-config.cjs'),
		'module.exports = { externals: ["external-a"], prebuilds: ["native-a"], additionalEntrypoints: { worker: "./src/worker.ts" } }',
	)

	const definition = await loadModuleBuildDefinition(moduleDir)
	assert.deepEqual(definition.entryPoints, { main: './src/main.ts', worker: './src/worker.ts' })
	assert.deepEqual(definition.externals, ['external-a'])
	assert.deepEqual(definition.buildConfig.prebuilds, ['native-a'])

	const options = createEsbuildOptions(definition, { write: false, minify: false, sourcemap: false })
	assert.equal(options.bundle, true)
	assert.equal(options.metafile, true)
	assert.equal(options.write, false)
	assert.deepEqual(options.entryPoints, definition.entryPoints)
	assert.deepEqual(options.external, definition.externals)
})
