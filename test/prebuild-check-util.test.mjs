import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
	checkPrebuildCoverage,
	detectBinaryTargets,
	enforcePrebuildCoverage,
	PrebuildCoverageError,
} from '../dist/scripts/lib/prebuild-check-util.js'

function elf(machine) {
	const buf = Buffer.alloc(64)
	buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0)
	buf.writeUInt16LE(machine, 18)
	return buf
}

function pe(machine) {
	const buf = Buffer.alloc(256)
	buf.write('MZ', 0, 'latin1')
	buf.writeUInt32LE(0x80, 0x3c)
	buf.write('PE\0\0', 0x80, 'latin1')
	buf.writeUInt16LE(machine, 0x84)
	return buf
}

function macho(cpuType) {
	const buf = Buffer.alloc(64)
	buf.writeUInt32LE(0xfeedfacf, 0)
	buf.writeUInt32LE(cpuType, 4)
	return buf
}

function fatMacho(...cpuTypes) {
	const buf = Buffer.alloc(8 + cpuTypes.length * 20)
	buf.writeUInt32BE(0xcafebabe, 0)
	buf.writeUInt32BE(cpuTypes.length, 4)
	cpuTypes.forEach((cpuType, i) => buf.writeUInt32BE(cpuType, 8 + i * 20))
	return buf
}

const BIN = {
	'linux-x64': elf(0x3e),
	'linux-arm64': elf(0xb7),
	'linux-arm': elf(0x28),
	'win32-x64': pe(0x8664),
	'win32-arm64': pe(0xaa64),
	'win32-ia32': pe(0x14c),
	'darwin-x64': macho(0x01000007),
	'darwin-arm64': macho(0x0100000c),
	'darwin-universal': fatMacho(0x01000007, 0x0100000c),
}

const ALL = ['linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64']

async function makePackage(t, files) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prebuild-check-'))
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture' }))
	for (const [file, contents] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true })
		await fs.writeFile(path.join(dir, file), contents)
	}
	return dir
}

test('detects the platform of binaries from their headers', async (t) => {
	const dir = await makePackage(t, {
		...Object.fromEntries(Object.entries(BIN).map(([name, contents]) => [`${name}.node`, contents])),
		'garbage.node': Buffer.from('not a binary at all'),
	})
	for (const name of [
		'linux-x64',
		'linux-arm64',
		'win32-x64',
		'win32-arm64',
		'win32-ia32',
		'darwin-x64',
		'darwin-arm64',
	]) {
		assert.deepEqual(await detectBinaryTargets(path.join(dir, `${name}.node`)), [name])
	}
	assert.deepEqual(await detectBinaryTargets(path.join(dir, 'darwin-universal.node')), ['darwin-x64', 'darwin-arm64'])
	assert.equal(await detectBinaryTargets(path.join(dir, 'garbage.node')), null)
})

test('a package without native code passes', async (t) => {
	const dir = await makePackage(t, { 'main.js': '' })
	const report = await checkPrebuildCoverage(dir)
	assert.deepEqual(report, { addons: [], ok: true })
})

test('complete pkg-prebuilds layout passes, and extra targets are ignored', async (t) => {
	const files = {}
	for (const target of [...ALL, 'linux-arm']) files[`prebuilds/freetype2-${target}/node-napi-v7.node`] = BIN[target]
	files['prebuilds/freetype2-linux-x64-musl/node-napi-v7.node'] = BIN['linux-x64']
	const report = await checkPrebuildCoverage(await makePackage(t, files))
	assert.equal(report.ok, true)
	assert.equal(report.addons.length, 1)
	assert.equal(report.addons[0].key, 'prebuilds/freetype2')
	assert.deepEqual(report.addons[0].missing, [])
})

test('complete prebuildify layout with a universal macos binary passes', async (t) => {
	const files = {}
	for (const target of ['linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64']) {
		files[`node_modules/usb/prebuilds/${target}/node.napi.node`] = BIN[target]
	}
	files['node_modules/usb/prebuilds/darwin-x64+arm64/node.napi.node'] = BIN['darwin-universal']
	const report = await checkPrebuildCoverage(await makePackage(t, files))
	assert.equal(report.ok, true)
	assert.equal(report.addons[0].key, 'node_modules/usb/prebuilds')
})

test('binaries are checked by content, not by their folder name', async (t) => {
	const files = {}
	for (const target of ALL) files[`prebuilds/${target}/node.napi.node`] = BIN[target]
	// Mislabelled: claims to be arm64 but is actually x64
	files['prebuilds/win32-arm64/node.napi.node'] = BIN['win32-x64']
	const report = await checkPrebuildCoverage(await makePackage(t, files))
	assert.equal(report.ok, false)
	assert.deepEqual(report.addons[0].missing, ['win32-arm64'])
})

test('missing targets are reported, and libraries sharing a prebuilds folder are checked separately', async (t) => {
	const files = {}
	for (const target of ALL) files[`prebuilds/lib-a-${target}/node-napi-v7.node`] = BIN[target]
	for (const target of ALL.filter((t) => t !== 'win32-arm64' && t !== 'darwin-x64')) {
		files[`prebuilds/lib-b-${target}/node-napi-v8.node`] = BIN[target]
	}
	const report = await checkPrebuildCoverage(await makePackage(t, files))
	assert.equal(report.ok, false)
	assert.deepEqual(
		report.addons.map((addon) => [addon.key, addon.missing]),
		[
			['prebuilds/lib-a', []],
			['prebuilds/lib-b', ['win32-arm64', 'darwin-x64']],
		],
	)
})

test('binaries outside of a prebuilds folder fail with a host-only hint', async (t) => {
	const report = await checkPrebuildCoverage(
		await makePackage(t, { 'node_modules/foo/build/Release/foo.node': BIN['linux-x64'] }),
	)
	assert.equal(report.ok, false)
	assert.equal(report.addons[0].kind, 'loose')
	assert.match(report.addons[0].hint, /build machine only/)
})

test('per-platform packages are grouped together and fail when only one is installed', async (t) => {
	const report = await checkPrebuildCoverage(
		await makePackage(t, {
			'node_modules/@napi-rs/canvas-linux-x64-gnu/package.json': JSON.stringify({
				name: '@napi-rs/canvas-linux-x64-gnu',
				os: ['linux'],
				cpu: ['x64'],
			}),
			'node_modules/@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node': BIN['linux-x64'],
			'node_modules/@napi-rs/canvas-linux-arm64-gnu/package.json': JSON.stringify({
				name: '@napi-rs/canvas-linux-arm64-gnu',
				os: ['linux'],
				cpu: ['arm64'],
			}),
			'node_modules/@napi-rs/canvas-linux-arm64-gnu/skia.linux-arm64-gnu.node': BIN['linux-arm64'],
		}),
	)
	assert.equal(report.addons.length, 1)
	assert.equal(report.addons[0].key, '@napi-rs/canvas')
	assert.equal(report.addons[0].kind, 'platform-package')
	assert.deepEqual(report.addons[0].missing, ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64'])
})

test('unrecognised binaries fail', async (t) => {
	const files = {}
	for (const target of ALL) files[`prebuilds/${target}/node.napi.node`] = BIN[target]
	files['prebuilds/linux-x64/extra.node'] = Buffer.from('nonsense contents')
	const report = await checkPrebuildCoverage(await makePackage(t, files))
	assert.equal(report.ok, false)
	assert.deepEqual(report.addons[0].missing, [])
	assert.deepEqual(report.addons[0].unrecognised, ['prebuilds/linux-x64/extra.node'])
})

test('enforcePrebuildCoverage throws unless ignored', async (t) => {
	const report = await checkPrebuildCoverage(
		await makePackage(t, { 'prebuilds/linux-x64/node.napi.node': BIN['linux-x64'] }),
	)
	const sink = () => {
		const writes = []
		return { writes, stream: { write: (text) => writes.push(text) } }
	}

	const err = sink()
	assert.throws(
		() => enforcePrebuildCoverage(report, { stdout: sink().stream, stderr: err.stream }),
		PrebuildCoverageError,
	)
	assert.match(err.writes.join(''), /PREBUILD ERROR/)
	assert.match(err.writes.join(''), /missing: linux-arm64, win32-x64, win32-arm64, darwin-x64, darwin-arm64/)

	const warn = sink()
	enforcePrebuildCoverage(report, { ignorePrebuildRules: true, stdout: sink().stream, stderr: warn.stream })
	assert.match(warn.writes.join(''), /PREBUILD WARNING/)
})

test('napi-rs style dot separated prebuild names are grouped together', async (t) => {
	const files = {}
	for (const target of ALL)
		files[`prebuilds/image-rs.${target}${target.startsWith('linux') ? '-gnu' : ''}.node`] = BIN[target]
	files['prebuilds/image-rs.linux-x64-musl.node'] = BIN['linux-x64']
	const report = await checkPrebuildCoverage(await makePackage(t, files))
	assert.equal(report.ok, true)
	assert.deepEqual(
		report.addons.map((addon) => addon.key),
		['prebuilds/image-rs'],
	)
})

test('musl and android binaries do not count towards linux coverage', async (t) => {
	const files = {}
	for (const target of ALL.filter((t) => t !== 'linux-arm64')) files[`prebuilds/${target}/node.napi.node`] = BIN[target]
	files['prebuilds/linux-arm64/node.napi.musl.node'] = BIN['linux-arm64']
	files['prebuilds/android-arm64/node.napi.node'] = BIN['linux-arm64']
	const report = await checkPrebuildCoverage(await makePackage(t, files))
	assert.deepEqual(report.addons[0].missing, ['linux-arm64'])
})

test('a platform specific addon alongside a complete one is accepted', async (t) => {
	const files = {}
	for (const target of ALL) files[`prebuilds/HID-${target}/node-napi-v4.node`] = BIN[target]
	files['prebuilds/HID_hidraw-linux-x64/node-napi-v4.node'] = BIN['linux-x64']
	files['prebuilds/HID_hidraw-linux-arm64/node-napi-v4.node'] = BIN['linux-arm64']
	const report = await checkPrebuildCoverage(await makePackage(t, files))
	assert.equal(report.ok, true)
	assert.match(report.addons[1].note, /specific to linux/)

	// but it still needs every arch for that platform
	delete files['prebuilds/HID_hidraw-linux-arm64/node-napi-v4.node']
	const report2 = await checkPrebuildCoverage(await makePackage(t, files))
	assert.deepEqual(report2.addons[1].missing, ['linux-arm64'])
})

test('a package which declares its supported os only needs binaries for that os', async (t) => {
	const report = await checkPrebuildCoverage(
		await makePackage(t, {
			'node_modules/fsevents/package.json': JSON.stringify({ name: 'fsevents', os: ['darwin'] }),
			'node_modules/fsevents/fsevents.node': BIN['darwin-universal'],
		}),
	)
	assert.equal(report.ok, true)
	assert.equal(report.addons[0].kind, 'loose')
})

test('per-platform packages listed as optionalDependencies are required even when none are installed', async (t) => {
	const report = await checkPrebuildCoverage(
		await makePackage(t, {
			'node_modules/usb/package.json': JSON.stringify({
				name: 'usb',
				optionalDependencies: {
					'@node-usb/usb-linux-x64-gnu': '1.0.0',
					'@node-usb/usb-linux-x64-musl': '1.0.0',
					'@node-usb/usb-win32-x64-msvc': '1.0.0',
					'@node-usb/usb-wasm32-wasi': '1.0.0',
				},
			}),
		}),
	)
	assert.equal(report.ok, false)
	assert.deepEqual(
		report.addons.map((addon) => [addon.key, addon.targets]),
		[['@node-usb/usb', []]],
	)
})

test('per-platform packages are matched by their os, cpu and libc fields', async (t) => {
	const files = {}
	for (const target of ALL) {
		const [os, cpu] = target.split('-')
		files[`node_modules/@x/lib-${target}/package.json`] = JSON.stringify({
			name: `@x/lib-${target}`,
			os: [os],
			cpu: [cpu],
			...(os === 'linux' ? { libc: ['glibc'] } : {}),
		})
	}
	// a musl package does not provide glibc coverage
	files['node_modules/@x/lib-linux-arm64/package.json'] = JSON.stringify({
		name: '@x/lib-linux-arm64-musl',
		os: ['linux'],
		cpu: ['arm64'],
		libc: ['musl'],
	})
	const report = await checkPrebuildCoverage(await makePackage(t, files))
	assert.deepEqual(
		report.addons.map((addon) => [addon.key, addon.missing]),
		[['@x/lib', ['linux-arm64']]],
	)
})
