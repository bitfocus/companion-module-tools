import assert from 'node:assert/strict'
import test from 'node:test'
import { createLicensePolicyIssues } from '../dist/scripts/lib/license-warning-util.js'

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

for (const expression of ['MIT', 'ISC', 'BSD-2-Clause', 'MIT AND ISC', 'MIT OR ISC', 'MIT OR GPL-3.0-only', 'ISC OR GPL-3.0-only', '(MIT AND ISC) OR GPL-3.0-only']) {
	test(`allows compatible dependency expression ${expression}`, () => assert.deepEqual(messages(pkg('external', 'dep', '1.0.0', expression)), []))
}

for (const expression of ['GPL-3.0-only', 'MIT AND GPL-3.0-only', 'MIT AND Apache-2.0', 'GPL-3.0-only OR Apache-2.0', '(MIT AND GPL-3.0-only) OR Apache-2.0', 'MIT WITH LLVM-exception', 'MIT+', 'ISC+', 'BSD-2-Clause+', 'garbage', undefined]) {
	test(`rejects incompatible dependency expression ${expression ?? 'missing'}`, () => {
		const result = messages(pkg('external', 'dep', '1.0.0', expression))
		assert.equal(result.length, 1)
		assert.match(result[0], /Dependency dep@1\.0\.0/)
	})
}

test('explains incompatible AND obligations, including nested incompatible OR branches', () => {
	for (const expression of ['MIT AND GPL-3.0-only', '(MIT AND GPL-3.0-only) OR Apache-2.0']) {
		assert.match(messages(pkg('external', 'dep', '1.0.0', expression))[0], /both licenses may apply, declaration ambiguous and incompatible; ask author to use OR if either license may be chosen or clarify licensing\./)
	}
})

test('rejects SPDX WITH exception modifiers', () => {
	assert.match(messages(pkg('external', 'dep', '1.0.0', 'MIT WITH LLVM-exception'))[0], /incompatible license declaration MIT WITH LLVM-exception/)
})

test('requires project declared license exactly MIT after trimming', () => {
	assert.deepEqual(messages(pkg('project', 'project', '1.0.0', ' MIT ')), [])
	assert.match(messages(pkg('project', 'project', '1.0.0', 'MIT OR ISC'))[0], /Your module must be licensed under MIT; found MIT OR ISC\./)
	assert.match(messages(pkg('project', 'project', '1.0.0', undefined))[0], /Your module must be licensed under MIT; no declared license found\./)
})

test('reports same name/version dependencies with distinct declarations and deterministic order', () => {
	const packages = [
		pkg('external', 'dep', '1.0.0', 'GPL-3.0-only'),
		pkg('bundled', 'dep', '1.0.0', 'Apache-2.0'),
		pkg('external', 'dep', '1.0.0', 'Apache-2.0'),
	]
	const expected = [
		'Dependency dep@1.0.0 has incompatible license declaration Apache-2.0.',
		'Dependency dep@1.0.0 has incompatible license declaration GPL-3.0-only.',
	]
	assert.deepEqual(messages(...packages), expected)
	assert.deepEqual(messages(...packages.reverse()), expected)
})

test('deduplicates bundled and external dependency, project first and package sorted', () => {
	const result = issues(
		pkg('external', 'zeta', '1.0.0', 'GPL-3.0-only'),
		pkg('bundled', 'alpha', '1.0.0', 'Apache-2.0'),
		pkg('external', 'alpha', '1.0.0', 'Apache-2.0'),
		pkg('project', 'project', '1.0.0', 'GPL-3.0-only'),
	)
	assert.deepEqual(result.map((issue) => issue.message), [
		'Your module must be licensed under MIT; found GPL-3.0-only.',
		'Dependency alpha@1.0.0 has incompatible license declaration Apache-2.0.',
		'Dependency zeta@1.0.0 has incompatible license declaration GPL-3.0-only.',
	])
})
