import assert from 'node:assert/strict'
import test from 'node:test'
import { warnForLegalInventory } from '../dist/scripts/lib/build-util.js'

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
	],
}

for (const [moduleType, includes, excludes] of [
	['connection', 'Bitfocus Buttons', undefined],
	['surface', 'this surface when it is used over the network', 'Bitfocus Buttons'],
]) {
	test(`build emits non-failing ${moduleType} warning`, () => {
		const writes = []
		warnForLegalInventory(inventory, moduleType, { isTTY: false, write: (text) => writes.push(text) })
		assert.match(writes.join(''), new RegExp(includes))
		if (excludes) assert.doesNotMatch(writes.join(''), new RegExp(excludes))
	})
}
