import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeInventoryPath } from '../dist/scripts/lib/license-util.js'

test('normalizes paths without leaking package root', () => {
	assert.equal(normalizeInventoryPath('/repo/node_modules/example/src/index.js', '/repo/node_modules/example'), 'src/index.js')
})
