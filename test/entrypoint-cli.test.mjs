import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'
import path from 'node:path'

const binaries = [
	['companion-module-build', 'build-connection', 'Builds the companion connection module'],
	['companion-surface-build', 'build-surface', 'Builds the companion surface module'],
	['companion-module-check', 'check-connection', 'Checks the companion connection module'],
	['companion-surface-check', 'check-surface', 'Checks the companion surface module'],
]

function run(binary, args) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [path.join('dist', 'scripts', `${binary}.js`), ...args], {
			cwd: path.resolve('.'),
		})
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', (data) => (stdout += data))
		child.stderr.on('data', (data) => (stderr += data))
		child.on('close', (code) => resolve({ code, stdout, stderr }))
	})
}

for (const [binary, script, description] of binaries) {
	test(`${binary} documents license override`, async () => {
		const result = await run(script, ['--help'])
		assert.equal(result.code, 0)
		assert.match(result.stdout, /--ignore-license-rules: Report license policy issues as warnings instead of failing/)
		assert.match(result.stdout, new RegExp(description))
	})
}

test('argv option helper handles zx hyphenated argv key', async () => {
	const { ignoreLicenseRules } = await import('../dist/scripts/lib/cli-options.js')
	assert.equal(ignoreLicenseRules({ 'ignore-license-rules': true }), true)
	assert.equal(ignoreLicenseRules({ 'ignore-license-rules': false }), false)
	assert.equal(ignoreLicenseRules({}), false)
})
