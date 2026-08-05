import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyLicenseExpression } from '../dist/scripts/lib/license-warning-util.js'

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
