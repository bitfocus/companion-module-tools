import assert from 'node:assert/strict'
import test from 'node:test'
import {
	createLicensePolicyIssues,
	enforceLicensePolicy,
	LicensePolicyError,
	SUPPORTED_PROJECT_LICENSES,
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
const project = (declaredLicense) => pkg('project', 'project', '1.0.0', declaredLicense)
const issues = (...packages) => createLicensePolicyIssues({ diagnostics: [], packages })
const messages = (...packages) => issues(...packages).map((issue) => issue.message)
const dependencyMessages = (projectLicense, expression) =>
	messages(project(projectLicense), pkg('external', 'dep', '1.0.0', expression))

test('supports an MIT and two GPL project licenses', () =>
	assert.deepEqual(SUPPORTED_PROJECT_LICENSES, ['MIT', 'GPL-2.0-only', 'GPL-3.0-only']))

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
	'MPL-2.0',
	'MIT AND ISC',
	'MIT OR ISC',
	'MIT OR GPL-3.0-only',
	'ISC OR GPL-3.0-only',
	'(MIT AND ISC) OR GPL-3.0-only',
]) {
	test(`allows dependency expression ${expression} for an MIT module`, () =>
		assert.deepEqual(dependencyMessages('MIT', expression), []))
}

for (const expression of [
	'GPL-3.0-only',
	'GPL-2.0-only',
	'LGPL-2.1-only',
	'LGPL-3.0-only',
	'MIT AND GPL-3.0-only',
	'MIT AND AGPL-3.0-only',
	'GPL-3.0-only OR AGPL-3.0-only',
	'(MIT AND GPL-3.0-only) OR AGPL-3.0-only',
	'MIT WITH LLVM-exception',
	'MIT+',
	'ISC+',
	'BSD-2-Clause+',
]) {
	test(`rejects dependency expression ${expression} for an MIT module`, () => {
		const result = dependencyMessages('MIT', expression)
		assert.equal(result.length, 1)
		assert.match(result[0], /Dependency dep@1\.0\.0/)
	})
}

for (const expression of [
	'MIT',
	'ISC',
	'BSD-3-Clause',
	'0BSD',
	'GPL-2.0-only',
	'GPL-2.0-or-later',
	'MPL-2.0',
	'GPL-2.0',
	'GPL-2.0+',
	'MIT AND GPL-2.0-only',
	'Apache-2.0 OR MIT',
]) {
	test(`allows dependency expression ${expression} for a GPL-2.0-only module`, () =>
		assert.deepEqual(dependencyMessages('GPL-2.0-only', expression), []))
}

for (const expression of [
	'Apache-2.0',
	'CC-BY-3.0',
	'CC-BY-4.0',
	'GPL-3.0-only',
	'GPL-3.0-or-later',
	'LGPL-2.1-only',
	'LGPL-2.1-or-later',
	'LGPL-3.0-only',
	'AGPL-3.0-only',
	'MIT AND Apache-2.0',
]) {
	test(`rejects dependency expression ${expression} for a GPL-2.0-only module`, () => {
		const result = dependencyMessages('GPL-2.0-only', expression)
		assert.equal(result.length, 1)
		assert.match(result[0], /not compatible with the GPL-2\.0-only license policy/)
	})
}

for (const expression of [
	'MIT',
	'0BSD',
	'Apache-2.0',
	'MPL-2.0',
	'GPL-3.0-only',
	'GPL-3.0',
	'GPL-3.0-or-later',
	'GPL-2.0-or-later',
	'GPL-2.0+',
]) {
	test(`allows dependency expression ${expression} for a GPL-3.0-only module`, () =>
		assert.deepEqual(dependencyMessages('GPL-3.0-only', expression), []))
}

// GPL-2.0-only cannot be taken to GPL-3.0, unlike its "or later" form
for (const expression of ['GPL-2.0-only', 'GPL-2.0', 'CC-BY-4.0', 'AGPL-3.0-only', 'LGPL-2.1-only']) {
	test(`rejects dependency expression ${expression} for a GPL-3.0-only module`, () =>
		assert.match(dependencyMessages('GPL-3.0-only', expression)[0], /GPL-3\.0-only license policy/))
}

test('treats a trailing plus as the or-later form of the same license', () => {
	assert.deepEqual(dependencyMessages('GPL-2.0-only', 'GPL-2.0+'), [])
	assert.match(dependencyMessages('MIT', 'GPL-2.0+')[0], /license declaration GPL-2\.0\+ which is not compatible/)
})

test('names the applied policy in dependency messages', () => {
	assert.equal(
		dependencyMessages('MIT', 'GPL-2.0-only')[0],
		'Dependency dep@1.0.0 has license declaration GPL-2.0-only which is not compatible with the MIT license policy.',
	)
	assert.equal(
		dependencyMessages('GPL-2.0-only', 'Apache-2.0')[0],
		'Dependency dep@1.0.0 has license declaration Apache-2.0 which is not compatible with the GPL-2.0-only license policy.',
	)
})

test('falls back to the MIT policy when the project license is unusable', () => {
	const result = messages(project('AGPL-3.0-only'), pkg('external', 'dep', '1.0.0', 'GPL-2.0-only'))
	assert.equal(result.length, 2)
	assert.match(result[1], /not compatible with the MIT license policy/)
})

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
			`Dependency dep@1.0.0 has license declaration ${expression} which is not compatible with the MIT license policy. Both licenses may apply, making this declaration ambiguous and incompatible. Ask package author to use OR if either license may be chosen, or clarify package licensing.`,
		)
	}
})

test('rejects SPDX WITH exception modifiers', () => {
	assert.match(
		messages(pkg('external', 'dep', '1.0.0', 'MIT WITH LLVM-exception'))[0],
		/license declaration MIT WITH LLVM-exception/,
	)
})

test('requires a supported project declared license after trimming', () => {
	assert.deepEqual(messages(project(' MIT ')), [])
	assert.deepEqual(messages(project(' GPL-2.0-only ')), [])
	assert.match(
		messages(project('MIT OR ISC'))[0],
		/Your module is licensed as MIT OR ISC, and dual licensing is not supported\. We recommend MIT for the widest compatibility, but also accept GPL-2\.0-only or GPL-3\.0-only when necessary\./,
	)
	assert.match(
		messages(project('GPL-2.0'))[0],
		/Your module is licensed as GPL-2\.0, which is not supported\. We recommend MIT for the widest compatibility, but also accept GPL-2\.0-only or GPL-3\.0-only when necessary\./,
	)
	assert.match(
		messages(project(undefined))[0],
		/Your module does not declare a license in package\.json\. We recommend MIT for the widest compatibility, but also accept GPL-2\.0-only or GPL-3\.0-only when necessary\./,
	)
})

test('reports a dual licensed module without explaining dependency ambiguity', () => {
	assert.equal(
		messages(project('MIT AND GPL-3.0-only'))[0],
		'Your module is licensed as MIT AND GPL-3.0-only, and dual licensing is not supported. We recommend MIT for the widest compatibility, but also accept GPL-2.0-only or GPL-3.0-only when necessary. Talk to us if you have a reason to use a different license.',
	)
	for (const declaration of ['MIT OR GPL-3.0-only', 'MIT AND ISC', '(MIT AND GPL-3.0-only) OR AGPL-3.0-only']) {
		assert.match(messages(project(declaration))[0], /and dual licensing is not supported\./)
		assert.doesNotMatch(messages(project(declaration))[0], /licenses may apply|Ask package author/)
	}
	// A single unsupported license is not dual licensing, and an unparseable one is reported the same way
	assert.match(messages(project('AGPL-3.0-only'))[0], /as AGPL-3\.0-only, which is not supported\./)
	assert.match(messages(project('MIT AND'))[0], /as MIT AND, which is not supported\./)
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
		'Dependency dep@1.0.0 has license declaration AGPL-3.0-only which is not compatible with the MIT license policy.',
		'Dependency dep@1.0.0 has license declaration GPL-3.0-only which is not compatible with the MIT license policy.',
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
					packages: [pkg('external', 'zeta', '1.0.0', 'GPL-3.0-only'), project('AGPL-3.0-only')],
				},
				{ stderr: { write: (text) => writes.push(text) } },
			),
		(error) => error instanceof LicensePolicyError,
	)
	assert.deepEqual(writes, [
		'LICENSE ERROR: Your module is licensed as AGPL-3.0-only, which is not supported. We recommend MIT for the widest compatibility, but also accept GPL-2.0-only or GPL-3.0-only when necessary. Talk to us if you have a reason to use a different license.\n',
		'LICENSE ERROR: Dependency zeta@1.0.0 has license declaration GPL-3.0-only which is not compatible with the MIT license policy.\n',
		'License validation failed with 2 errors.\n',
		'Not sure what to do about these? Ask in the Bitfocus community Slack, we are happy to help you work out what they mean for your module.\n',
	])
})

test('ignore mode warns and returns, including zero issues', () => {
	const writes = []
	assert.doesNotThrow(() =>
		enforceLicensePolicy(
			{ diagnostics: [], packages: [project('AGPL-3.0-only')] },
			{ ignoreLicenseRules: true, stderr: { write: (text) => writes.push(text) } },
		),
	)
	assert.deepEqual(writes, [
		'LICENSE WARNING: Your module is licensed as AGPL-3.0-only, which is not supported. We recommend MIT for the widest compatibility, but also accept GPL-2.0-only or GPL-3.0-only when necessary. Talk to us if you have a reason to use a different license.\n',
		'License validation ignored 1 error because --ignore-license-rules was provided.\n',
	])
	const emptyWrites = []
	enforceLicensePolicy(
		{ diagnostics: [], packages: [project('MIT')] },
		{ ignoreLicenseRules: true, stderr: { write: (text) => emptyWrites.push(text) } },
	)
	assert.deepEqual(emptyWrites, [])
})

test('deduplicates bundled and external dependency, project first and package sorted', () => {
	const result = issues(
		pkg('external', 'zeta', '1.0.0', 'GPL-3.0-only'),
		pkg('bundled', 'alpha', '1.0.0', 'AGPL-3.0-only'),
		pkg('external', 'alpha', '1.0.0', 'AGPL-3.0-only'),
		project('AGPL-3.0-only'),
	)
	assert.deepEqual(
		result.map((issue) => issue.message),
		[
			'Your module is licensed as AGPL-3.0-only, which is not supported. We recommend MIT for the widest compatibility, but also accept GPL-2.0-only or GPL-3.0-only when necessary. Talk to us if you have a reason to use a different license.',
			'Dependency alpha@1.0.0 has license declaration AGPL-3.0-only which is not compatible with the MIT license policy.',
			'Dependency zeta@1.0.0 has license declaration GPL-3.0-only which is not compatible with the MIT license policy.',
		],
	)
})
