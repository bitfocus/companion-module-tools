import assert from 'node:assert/strict'
import test from 'node:test'
import { enforceLegalInventory } from '../dist/scripts/lib/build-util.js'

const inventory = {
	diagnostics: [],
	packages: [
		{
			kind: 'project',
			name: 'fixture',
			declaredLicense: 'AGPL-3.0-only',
			packageRoot: '',
			contributingPaths: new Set(),
			legalTexts: [],
		},
		{
			kind: 'external',
			name: 'bad-dependency',
			version: '1.0.0',
			declaredLicense: 'GPL-3.0-only',
			packageRoot: '',
			contributingPaths: new Set(),
			legalTexts: [],
		},
	],
}

test('build rejects incompatible inventory after printing all issues', () => {
	const writes = []
	assert.throws(
		() => enforceLegalInventory(inventory, { stderr: { isTTY: false, write: (text) => writes.push(text) } }),
		/License validation failed with 2 errors/,
	)
	assert.match(
		writes.join(''),
		/LICENSE ERROR: Your module is licensed as AGPL-3\.0-only, which is not supported\. We recommend MIT for the widest compatibility, but also accept GPL-2\.0-only or GPL-3\.0-only when necessary\./,
	)
	assert.match(
		writes.join(''),
		/LICENSE ERROR: Dependency bad-dependency@1\.0\.0 has license declaration GPL-3\.0-only which is not compatible with the MIT license policy\./,
	)
})

test('build ignore option warns and continues', () => {
	const writes = []
	assert.doesNotThrow(() =>
		enforceLegalInventory(inventory, {
			ignoreLicenseRules: true,
			stderr: { isTTY: false, write: (text) => writes.push(text) },
		}),
	)
	assert.match(
		writes.join(''),
		/LICENSE WARNING: Your module is licensed as AGPL-3\.0-only, which is not supported\. We recommend MIT for the widest compatibility, but also accept GPL-2\.0-only or GPL-3\.0-only when necessary\./,
	)
})
