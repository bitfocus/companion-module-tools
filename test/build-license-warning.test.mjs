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

for (const moduleType of ['connection', 'surface']) {
	test(`build emits non-failing ${moduleType} warning`, () => {
		const writes = []
		warnForLegalInventory(inventory, moduleType, { isTTY: false, write: (text) => writes.push(text) })
		assert.match(writes.join(''), /Your module must be licensed under MIT; found AGPL-3\.0-only\./)
		assert.doesNotMatch(writes.join(''), /Buttons|surface|Companion/)
	})
}
