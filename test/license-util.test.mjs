import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { collectMetafilePackages, normalizeInventoryPath } from '../dist/scripts/lib/license-util.js'

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

	const packages = await collectMetafilePackages(projectDir, metafile)
	assert.deepEqual(
		packages.map((pkg) => ({
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
