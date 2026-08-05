import assert from 'node:assert/strict'
import test from 'node:test'
import {
	classifyLicenseExpression,
	createLicenseWarnings,
	formatLicenseWarning,
	printLicenseWarnings,
} from '../dist/scripts/lib/license-warning-util.js'

const inventory = {
	diagnostics: [],
	packages: [
		{
			kind: 'project',
			name: 'project',
			version: '1.0.0',
			declaredLicense: 'MIT AND AGPL-3.0-only',
			packageRoot: '',
			contributingPaths: new Set(),
			legalTexts: [],
		},
		{
			kind: 'bundled',
			name: 'non-commercial-dep',
			version: '2.0.0',
			declaredLicense: 'CC-BY-NC-4.0',
			packageRoot: '/bundled',
			contributingPaths: new Set(),
			legalTexts: [],
		},
		{
			kind: 'external',
			name: 'non-commercial-dep',
			version: '2.0.0',
			declaredLicense: 'CC-BY-NC-4.0',
			packageRoot: '/external',
			contributingPaths: new Set(),
			legalTexts: [],
		},
	],
}

test('renders module and surface restricted-license warnings', () => {
	const moduleWarnings = createLicenseWarnings(inventory, 'connection')
	assert.equal(moduleWarnings.length, 3)
	assert.match(
		moduleWarnings[0].text,
		/^WARNING: This module is licensed under MIT AND AGPL-3.0-only, which makes it unavailable in Bitfocus Buttons\./,
	)
	assert.match(
		moduleWarnings[0].text,
		/Some commercial users of Companion might be limited by this module when it is used over the network\./,
	)
	assert.match(
		moduleWarnings[1].text,
		/^LICENSE AMBIGUITY: The warning above is shown because MIT AND AGPL-3.0-only combines AGPLv3\/SSPL obligations using AND;/,
	)
	assert.match(
		moduleWarnings[2].text,
		/^WARNING: Dependency non-commercial-dep@2.0.0 is licensed under CC-BY-NC-4.0, which makes this module unavailable in Bitfocus Buttons\./,
	)
	assert.doesNotMatch(moduleWarnings[2].text, /network/)
	assert.match(moduleWarnings[2].text, /Review license terms before publishing or using this module commercially\./)

	const surfaceWarnings = createLicenseWarnings(inventory, 'surface')
	assert.doesNotMatch(surfaceWarnings.map((warning) => warning.text).join('\n'), /Buttons/)
	assert.match(surfaceWarnings[0].text, /this surface when it is used over the network/)
	assert.match(surfaceWarnings[2].text, /may restrict this surface's distribution or use/)
	assert.match(surfaceWarnings[2].text, /Review license terms before publishing or using this surface commercially\./)
})

test('formats warnings for TTY and writes plain redirected output', () => {
	const [restricted, ambiguity] = createLicenseWarnings(inventory, 'connection')
	assert.match(formatLicenseWarning(restricted, true), /^\u001b\[38;5;208mWARNING:/)
	assert.match(formatLicenseWarning(ambiguity, true), /^\u001b\[33mLICENSE AMBIGUITY:/)
	assert.ok(formatLicenseWarning(restricted, true).endsWith('\u001b[0m'))
	assert.doesNotMatch(formatLicenseWarning(restricted, false), /\u001b\[/)
	const writes = []
	printLicenseWarnings([restricted], { isTTY: false, write: (text) => writes.push(text) })
	assert.deepEqual(writes, [`${restricted.text}\n`])
})

for (const [expression, restricted, families, agplOrSsplAndAmbiguity] of [
	['MIT', false, [], false],
	['CC-BY-NC-4.0', true, ['non-commercial'], false],
	['MIT OR AGPL-3.0-only', false, [], false],
	['MIT AND AGPL-3.0-only', true, ['network-copyleft'], true],
	['MIT AND BSD-3-Clause', false, [], false],
	['AGPL-3.0-only OR SSPL-1.0', true, ['network-copyleft'], false],
	['CC-BY-NC-4.0 OR AGPL-3.0-only', true, ['network-copyleft', 'non-commercial'], false],
	['(MIT AND AGPL-3.0-only) OR Apache-2.0', false, [], false],
	['(MIT AND AGPL-3.0-only) OR (BSD-3-Clause AND SSPL-1.0)', true, ['network-copyleft'], true],
	['Apache-2.0 AND CC-BY-NC-SA-4.0', true, ['non-commercial'], false],
	['Non-Commercial', true, ['non-commercial'], false],
	['Server Side Public License', true, ['network-copyleft'], false],
	['SSPL', true, ['network-copyleft'], false],
	['CC-NC', true, ['non-commercial'], false],
	['MIT OR SSPL', false, [], false],
	['MIT AND SSPL', true, ['network-copyleft'], true],
	['MIT OR AGPLv3', false, [], false],
	['MIT AND AGPLv3', true, ['network-copyleft'], true],
	[undefined, false, [], false],
	['', false, [], false],
	['garbage', false, [], false],
]) {
	test(`classifies ${expression ?? 'missing'} license expression`, () => {
		const result = classifyLicenseExpression(expression)
		assert.equal(result.restricted, restricted)
		assert.deepEqual([...result.families].sort(), families)
		assert.equal(result.agplOrSsplAndAmbiguity, agplOrSsplAndAmbiguity)
	})
}
