import assert from 'node:assert/strict'
import test from 'node:test'
import {
	createLicensePolicyIssues,
	enforceLicensePolicy,
	LicensePolicyError,
} from '../dist/scripts/lib/license-warning-util.js'

const pkg = (kind, name, version, declaredLicense) => ({
	kind,
	name,
	version,
	declaredLicense,
	packageRoot: `/${name}`,
	contributingPaths: new Set(),
	legalTexts: [],
})
const issues = (...packages) => createLicensePolicyIssues({ diagnostics: [], packages })
const messages = (...packages) => issues(...packages).map((issue) => issue.message)

for (const expression of [
	'MIT',
	'MIT-0',
	'ISC',
	'BSD-2-Clause',
	'BSD-3-Clause',
	'Apache-2.0',
	'0BSD',
	'CC0-1.0',
	'Unlicense',
	'BlueOak-1.0.0',
	'CC-BY-3.0',
	'CC-BY-4.0',
	'Python-2.0',
	'MIT AND ISC',
	'MIT OR ISC',
	'MIT OR GPL-3.0-only',
	'ISC OR GPL-3.0-only',
	'(MIT AND ISC) OR GPL-3.0-only',
]) {
	test(`allows compatible dependency expression ${expression}`, () =>
		assert.deepEqual(messages(pkg('external', 'dep', '1.0.0', expression)), []))
}

for (const expression of [
	'GPL-3.0-only',
	'MIT AND GPL-3.0-only',
	'MIT AND AGPL-3.0-only',
	'GPL-3.0-only OR AGPL-3.0-only',
	'(MIT AND GPL-3.0-only) OR AGPL-3.0-only',
	'MIT WITH LLVM-exception',
	'MIT+',
	'ISC+',
	'BSD-2-Clause+',
]) {
	test(`rejects incompatible dependency expression ${expression ?? 'missing'}`, () => {
		const result = messages(pkg('external', 'dep', '1.0.0', expression))
		assert.equal(result.length, 1)
		assert.match(result[0], /Dependency dep@1\.0\.0/)
	})
}

test('distinguishes missing and malformed dependency declarations', () => {
	assert.match(
		messages(pkg('external', 'missing-dep', '1.0.0', undefined))[0],
		/Dependency missing-dep@1\.0\.0 has no declared license\./,
	)
	assert.match(
		messages(pkg('external', 'malformed-dep', '1.0.0', 'MIT AND'))[0],
		/Dependency malformed-dep@1\.0\.0 has unparseable license declaration MIT AND\./,
	)
})

test('explains incompatible AND obligations, including nested incompatible OR branches', () => {
	for (const expression of ['MIT AND GPL-3.0-only', '(MIT AND GPL-3.0-only) OR AGPL-3.0-only']) {
		assert.equal(
			messages(pkg('external', 'dep', '1.0.0', expression))[0],
			`Dependency dep@1.0.0 has incompatible license declaration ${expression}. Both licenses may apply, making this declaration ambiguous and incompatible. Ask package author to use OR if either license may be chosen, or clarify package licensing.`,
		)
	}
})

test('rejects SPDX WITH exception modifiers', () => {
	assert.match(
		messages(pkg('external', 'dep', '1.0.0', 'MIT WITH LLVM-exception'))[0],
		/incompatible license declaration MIT WITH LLVM-exception/,
	)
})

test('requires project declared license exactly MIT after trimming', () => {
	assert.deepEqual(messages(pkg('project', 'project', '1.0.0', ' MIT ')), [])
	assert.match(
		messages(pkg('project', 'project', '1.0.0', 'MIT OR ISC'))[0],
		/Your module must be licensed under MIT; found MIT OR ISC\./,
	)
	assert.match(
		messages(pkg('project', 'project', '1.0.0', undefined))[0],
		/Your module must be licensed under MIT; no declared license found\./,
	)
})

test('explains ambiguous incompatible project AND declarations without changing MIT rule', () => {
	assert.equal(
		messages(pkg('project', 'project', '1.0.0', 'MIT AND GPL-3.0-only'))[0],
		'Your module must be licensed under MIT; found MIT AND GPL-3.0-only. Both licenses may apply, making this declaration ambiguous and incompatible. Ask package author to use OR if either license may be chosen, or clarify package licensing.',
	)
	assert.doesNotMatch(messages(pkg('project', 'project', '1.0.0', 'MIT OR GPL-3.0-only'))[0], /both licenses may apply/)
	assert.doesNotMatch(messages(pkg('project', 'project', '1.0.0', 'MIT AND ISC'))[0], /both licenses may apply/)
	assert.match(
		messages(pkg('project', 'project', '1.0.0', '(MIT AND GPL-3.0-only) OR AGPL-3.0-only'))[0],
		/\. Both licenses may apply, making this declaration ambiguous and incompatible\. Ask package author to use OR if either license may be chosen, or clarify package licensing\.$/,
	)
})

test('escapes control characters in displayed declarations', () => {
	const declaration = 'MIT\r\nAND\tGPL'
	const message = messages(pkg('external', 'multiline-dep', '1.0.0', declaration))[0]
	assert.match(message, /unparseable license declaration MIT\\r\\nAND\\tGPL\./)
	assert.doesNotMatch(message, /\r|\n|\t/)
})

test('reports same name/version dependencies with distinct declarations and deterministic order', () => {
	const packages = [
		pkg('external', 'dep', '1.0.0', 'GPL-3.0-only'),
		pkg('bundled', 'dep', '1.0.0', 'AGPL-3.0-only'),
		pkg('external', 'dep', '1.0.0', 'AGPL-3.0-only'),
	]
	const expected = [
		'Dependency dep@1.0.0 has incompatible license declaration AGPL-3.0-only.',
		'Dependency dep@1.0.0 has incompatible license declaration GPL-3.0-only.',
	]
	assert.deepEqual(messages(...packages), expected)
	assert.deepEqual(messages(...packages.reverse()), expected)
})

test('enforces all issues with deterministic errors and summary', () => {
	const writes = []
	assert.throws(
		() =>
			enforceLicensePolicy(
				{
					diagnostics: [],
					packages: [
						pkg('external', 'zeta', '1.0.0', 'GPL-3.0-only'),
						pkg('project', 'project', '1.0.0', 'AGPL-3.0-only'),
					],
				},
				{ stderr: { write: (text) => writes.push(text) } },
			),
		(error) => error instanceof LicensePolicyError,
	)
	assert.deepEqual(writes, [
		'LICENSE ERROR: Your module must be licensed under MIT; found AGPL-3.0-only.\n',
		'LICENSE ERROR: Dependency zeta@1.0.0 has incompatible license declaration GPL-3.0-only.\n',
		'License validation failed with 2 errors.\n',
	])
})

test('ignore mode warns and returns, including zero issues', () => {
	const writes = []
	assert.doesNotThrow(() =>
		enforceLicensePolicy(
			{ diagnostics: [], packages: [pkg('project', 'project', '1.0.0', 'AGPL-3.0-only')] },
			{ ignoreLicenseRules: true, stderr: { write: (text) => writes.push(text) } },
		),
	)
	assert.deepEqual(writes, [
		'LICENSE WARNING: Your module must be licensed under MIT; found AGPL-3.0-only.\n',
		'License validation ignored 1 error because --ignore-license-rules was provided.\n',
	])
	const emptyWrites = []
	enforceLicensePolicy(
		{ diagnostics: [], packages: [pkg('project', 'project', '1.0.0', 'MIT')] },
		{ ignoreLicenseRules: true, stderr: { write: (text) => emptyWrites.push(text) } },
	)
	assert.deepEqual(emptyWrites, [])
})

test('deduplicates bundled and external dependency, project first and package sorted', () => {
	const result = issues(
		pkg('external', 'zeta', '1.0.0', 'GPL-3.0-only'),
		pkg('bundled', 'alpha', '1.0.0', 'AGPL-3.0-only'),
		pkg('external', 'alpha', '1.0.0', 'AGPL-3.0-only'),
		pkg('project', 'project', '1.0.0', 'GPL-3.0-only'),
	)
	assert.deepEqual(
		result.map((issue) => issue.message),
		[
			'Your module must be licensed under MIT; found GPL-3.0-only.',
			'Dependency alpha@1.0.0 has incompatible license declaration AGPL-3.0-only.',
			'Dependency zeta@1.0.0 has incompatible license declaration GPL-3.0-only.',
		],
	)
})
