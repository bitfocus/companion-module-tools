import path from 'path'
import fs from 'fs/promises'

/**
 * The platforms that every native addon in a module package must have a binary for.
 * Note: darwin-x64 is expected to be dropped in the future
 */
export const REQUIRED_PREBUILD_TARGETS: readonly string[] = [
	'linux-x64',
	'linux-arm64',
	'win32-x64',
	'win32-arm64',
	'darwin-x64',
	'darwin-arm64',
]

const KNOWN_PLATFORMS = new Set(['linux', 'win32', 'darwin', 'freebsd', 'openbsd', 'android', 'sunos', 'aix', 'netbsd'])

// Tokens which appear at the end of the names of per-platform packages, eg `@napi-rs/canvas-linux-x64-gnu`
const PLATFORM_PACKAGE_SUFFIX_TOKENS = new Set([
	...KNOWN_PLATFORMS,
	'windows',
	'macos',
	'x64',
	'x86_64',
	'arm64',
	'aarch64',
	'ia32',
	'x86',
	'arm',
	'armv7',
	'gnu',
	'musl',
	'msvc',
	'gnueabihf',
	'musleabihf',
	'eabi',
	'gnueabi',
	'musleabi',
	'gnux32',
	'mingw',
	'riscv64',
	'ppc64',
	'ppc64le',
	's390x',
	'loong64',
	'mips64el',
	'wasm32',
	'wasi',
	'universal',
])

const HEADER_READ_SIZE = 4096

export type NativeAddonKind = 'prebuilds' | 'platform-package' | 'loose'

export interface NativeAddonReport {
	/** Identifies the addon these binaries belong to */
	key: string
	kind: NativeAddonKind
	/** The binaries found for this addon, relative to the package dir */
	files: string[]
	/** The platform-arch targets the binaries were compiled for */
	targets: string[]
	/** Required targets which no binary covers */
	missing: string[]
	/** Binaries whose platform could not be determined */
	unrecognised: string[]
	/** Advice on why this could be failing */
	hint?: string
	/** Explains why some required targets are not needed */
	note?: string
}

export interface PrebuildReport {
	addons: NativeAddonReport[]
	ok: boolean
}

export class PrebuildCoverageError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'PrebuildCoverageError'
	}
}

function elfArch(machine: number): string {
	switch (machine) {
		case 0x3e:
			return 'x64'
		case 0xb7:
			return 'arm64'
		case 0x03:
			return 'ia32'
		case 0x28:
			return 'arm'
		default:
			return `unknown(0x${machine.toString(16)})`
	}
}

function peArch(machine: number): string {
	switch (machine) {
		case 0x8664:
			return 'x64'
		case 0xaa64:
			return 'arm64'
		case 0x014c:
			return 'ia32'
		case 0x01c4:
			return 'arm'
		default:
			return `unknown(0x${machine.toString(16)})`
	}
}

function machoArch(cpuType: number): string {
	switch (cpuType) {
		case 0x01000007:
			return 'x64'
		case 0x0100000c:
			return 'arm64'
		case 0x00000007:
			return 'ia32'
		case 0x0000000c:
			return 'arm'
		default:
			return `unknown(0x${cpuType.toString(16)})`
	}
}

/**
 * Determine the platform(s) and arch(s) a native binary was compiled for, by inspecting its header.
 * Returns targets in the form `platform-arch`, or null if the file is not a recognised binary format
 */
export async function detectBinaryTargets(filePath: string): Promise<string[] | null> {
	const handle = await fs.open(filePath, 'r')
	try {
		const readAt = async (position: number, length: number): Promise<Buffer> => {
			const buffer = Buffer.alloc(length)
			const { bytesRead } = await handle.read(buffer, 0, length, position)
			return buffer.subarray(0, bytesRead)
		}

		const header = await readAt(0, HEADER_READ_SIZE)
		if (header.length < 8) return null

		// ELF (linux)
		if (header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
			if (header.length < 20) return null
			const littleEndian = header[5] !== 2
			const machine = littleEndian ? header.readUInt16LE(18) : header.readUInt16BE(18)
			const osAbi = header[7]
			const platform = osAbi === 9 ? 'freebsd' : osAbi === 12 ? 'openbsd' : osAbi === 2 ? 'netbsd' : 'linux'
			return [`${platform}-${elfArch(machine)}`]
		}

		// PE (windows)
		if (header[0] === 0x4d && header[1] === 0x5a) {
			if (header.length < 0x40) return null
			const peOffset = header.readUInt32LE(0x3c)
			const peHeader = peOffset + 6 <= header.length ? header.subarray(peOffset) : await readAt(peOffset, 6)
			if (peHeader.length < 6 || peHeader.readUInt32BE(0) !== 0x50450000) return null
			return [`win32-${peArch(peHeader.readUInt16LE(4))}`]
		}

		// Mach-O (macos), single architecture
		const magicLE = header.readUInt32LE(0)
		if (magicLE === 0xfeedfacf || magicLE === 0xfeedface) {
			return [`darwin-${machoArch(header.readUInt32LE(4))}`]
		}

		// Mach-O (macos), universal/fat binary containing multiple architectures
		const magicBE = header.readUInt32BE(0)
		if (magicBE === 0xcafebabe || magicBE === 0xcafebabf) {
			const entrySize = magicBE === 0xcafebabf ? 32 : 20
			const count = header.readUInt32BE(4)
			const entries = 8 + count * entrySize <= header.length ? header : await readAt(0, 8 + count * entrySize)
			const targets: string[] = []
			for (let i = 0; i < count; i++) {
				const offset = 8 + i * entrySize
				if (offset + 4 > entries.length) return null
				targets.push(`darwin-${machoArch(entries.readUInt32BE(offset))}`)
			}
			return targets.length ? targets : null
		}

		return null
	} finally {
		await handle.close()
	}
}

async function findNativeFiles(rootDir: string): Promise<{ binaries: string[]; packageJsons: string[] }> {
	const binaries: string[] = []
	const packageJsons: string[] = []

	const walk = async (dir: string): Promise<void> => {
		const entries = await fs.readdir(dir, { withFileTypes: true })
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name)
			if (entry.isDirectory()) {
				await walk(fullPath)
			} else if (entry.isFile() && entry.name.endsWith('.node')) {
				binaries.push(fullPath)
			} else if (entry.isFile() && entry.name === 'package.json') {
				packageJsons.push(fullPath)
			}
		}
	}

	await walk(rootDir)
	return { binaries: binaries.sort(), packageJsons: packageJsons.sort() }
}

type PackageJson = Record<string, unknown>

async function readPackageJson(dir: string, cache: Map<string, PackageJson | null>): Promise<PackageJson | null> {
	let json = cache.get(dir)
	if (json === undefined) {
		try {
			json = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as PackageJson
		} catch {
			json = null
		}
		cache.set(dir, json)
	}
	return json
}

/**
 * Find the nearest package.json for a file, without leaving the root dir
 */
async function findOwningPackageJson(
	rootDir: string,
	filePath: string,
	cache: Map<string, PackageJson | null>,
): Promise<PackageJson | null> {
	let dir = path.dirname(filePath)
	while (true) {
		const json = await readPackageJson(dir, cache)
		if (json) return json

		if (path.resolve(dir) === path.resolve(rootDir)) return null
		const parent = path.dirname(dir)
		if (parent === dir) return null
		dir = parent
	}
}

const PLATFORM_IN_NAME_REGEX = new RegExp(`(^|[-.])(${Array.from(KNOWN_PLATFORMS).join('|')})([-.+]|$)`)

/**
 * Strip the platform portion from a prebuild folder or file name.
 * eg `freetype2-linux-x64` -> `freetype2`, `image-rs.linux-x64-gnu` -> `image-rs`, `darwin-x64+arm64` -> ``
 */
function prebuildNamePrefix(name: string): string {
	const match = PLATFORM_IN_NAME_REGEX.exec(name)
	if (!match) return name
	return name.slice(0, match.index)
}

/**
 * Strip the platform portion from the name of a per-platform package.
 * eg `@napi-rs/canvas-linux-x64-gnu` -> `@napi-rs/canvas`, `@esbuild/linux-x64` -> `@esbuild`
 * Returns null if the name does not look like a per-platform package
 */
function platformPackageBaseName(name: string): string | null {
	const slash = name.indexOf('/')
	const scope = name.startsWith('@') && slash !== -1 ? name.slice(0, slash + 1) : ''
	const tokens = name.slice(scope.length).split('-')

	let foundPlatform = false
	while (tokens.length && PLATFORM_PACKAGE_SUFFIX_TOKENS.has(tokens[tokens.length - 1].toLowerCase())) {
		const token = tokens.pop()!.toLowerCase()
		if (KNOWN_PLATFORMS.has(token) || token === 'windows' || token === 'macos') foundPlatform = true
	}
	if (!foundPlatform) return null

	const rest = tokens.join('-')
	if (rest) return scope + rest
	return scope ? scope.slice(0, -1) : null
}

/**
 * Check a value against a package.json `os` or `cpu` style constraint, which can contain negations like `!win32`
 */
function matchesConstraint(value: string, constraint: unknown): boolean {
	if (!Array.isArray(constraint) || constraint.length === 0) return true
	const entries = constraint.filter((entry): entry is string => typeof entry === 'string')
	if (entries.includes(`!${value}`)) return false
	const positives = entries.filter((entry) => !entry.startsWith('!'))
	return positives.length === 0 || positives.includes(value)
}

function hasPlatformConstraint(pkgJson: PackageJson): boolean {
	return Array.isArray(pkgJson.os) || Array.isArray(pkgJson.cpu)
}

/**
 * Determine the targets a package says it supports, through its `os`, `cpu` and `libc` fields
 */
function packageJsonTargetFilter(pkgJson: PackageJson): (target: string) => boolean {
	return (target) => {
		const [platform, arch] = target.split('-')
		if (!matchesConstraint(platform, pkgJson.os) || !matchesConstraint(arch, pkgJson.cpu)) return false
		// We only support glibc on linux
		if (platform === 'linux' && !matchesConstraint('glibc', pkgJson.libc)) return false
		return true
	}
}

const PLATFORM_PACKAGE_HINT =
	'This library ships its binaries as separate packages per platform, and only the one(s) for the build machine got installed.'
const LOOSE_BINARY_HINT =
	'This binary is not in a prebuilds folder, so was most likely compiled or downloaded for the build machine only (eg by node-gyp, prebuild-install or node-pre-gyp).'

interface AddonGroup {
	kind: NativeAddonKind
	files: string[]
	targets: Set<string>
	unrecognised: string[]
	/** The prebuilds folder this group is in, if any */
	prebuildsDir?: string
	/** Limit which of the required targets apply to this addon */
	filter?: (target: string) => boolean
	note?: string
}

/**
 * Find every native addon in a package and check that it has binaries for every required target
 * @param packageDir The root of the package to check
 * @param requiredTargets Override the targets which must be covered
 */
export async function checkPrebuildCoverage(
	packageDir: string,
	requiredTargets: readonly string[] = REQUIRED_PREBUILD_TARGETS,
): Promise<PrebuildReport> {
	const { binaries, packageJsons } = await findNativeFiles(packageDir)
	const packageJsonCache = new Map<string, PackageJson | null>()

	const groups = new Map<string, AddonGroup>()
	const getGroup = (key: string, kind: NativeAddonKind): AddonGroup => {
		let group = groups.get(key)
		if (!group) {
			group = { kind, files: [], targets: new Set(), unrecognised: [] }
			groups.set(key, group)
		}
		return group
	}

	// Libraries which ship per-platform packages (eg napi-rs) list them as optionalDependencies, and the package manager installs only the matching ones
	for (const packageJsonPath of packageJsons) {
		const pkgJson = await readPackageJson(path.dirname(packageJsonPath), packageJsonCache)
		if (!pkgJson) continue

		// Packages it expects to have installed for each platform
		if (pkgJson.optionalDependencies && typeof pkgJson.optionalDependencies === 'object') {
			for (const depName of Object.keys(pkgJson.optionalDependencies)) {
				const baseName = platformPackageBaseName(depName)
				if (baseName) getGroup(baseName, 'platform-package')
			}
		}

		// An installed per-platform package
		if (typeof pkgJson.name === 'string' && hasPlatformConstraint(pkgJson)) {
			const baseName = platformPackageBaseName(pkgJson.name)
			if (baseName) {
				const group = getGroup(baseName, 'platform-package')
				const filter = packageJsonTargetFilter(pkgJson)
				for (const target of requiredTargets) {
					if (filter(target)) group.targets.add(target)
				}
			}
		}
	}

	for (const filePath of binaries) {
		const relativePath = path.relative(packageDir, filePath).split(path.sep).join('/')
		const segments = relativePath.split('/')

		const owningPackage = await findOwningPackageJson(packageDir, filePath, packageJsonCache)
		const platformBaseName =
			owningPackage && typeof owningPackage.name === 'string' && hasPlatformConstraint(owningPackage)
				? platformPackageBaseName(owningPackage.name)
				: null

		let group: AddonGroup
		const prebuildsIndex = segments.lastIndexOf('prebuilds')
		if (platformBaseName) {
			group = getGroup(platformBaseName, 'platform-package')
		} else if (prebuildsIndex !== -1 && prebuildsIndex < segments.length - 1) {
			// Some form of `prebuilds/<platform-ish>/<name>.node` or `prebuilds/<platform-ish>.node`
			const prebuildsDir = segments.slice(0, prebuildsIndex + 1).join('/')
			const prefix = prebuildNamePrefix(segments[prebuildsIndex + 1].replace(/\.node$/, ''))
			group = getGroup(prefix ? `${prebuildsDir}/${prefix}` : prebuildsDir, 'prebuilds')
			group.prebuildsDir = prebuildsDir
		} else {
			group = getGroup(relativePath, 'loose')
		}

		// A package which declares it only works on some platforms (eg fsevents) only needs binaries for those
		if (owningPackage && !platformBaseName && hasPlatformConstraint(owningPackage) && !group.filter) {
			group.filter = packageJsonTargetFilter(owningPackage)
			group.note = `${String(owningPackage.name)} declares itself as only supporting some platforms`
		}

		group.files.push(relativePath)

		const targets = await detectBinaryTargets(filePath)
		if (targets) {
			// The binary header can't easily tell glibc/musl/android apart, so use the naming to exclude the unsupported ones
			const nameTokens = new Set(
				[
					...segments.slice(prebuildsIndex !== -1 ? prebuildsIndex + 1 : segments.length - 1),
					platformBaseName ? String(owningPackage?.name) : '',
				]
					.join('/')
					.toLowerCase()
					.split(/[^a-z0-9]+/),
			)
			const isOtherLinux = ['musl', 'android', 'musleabihf', 'musleabi', 'ohos', 'openharmony'].some((token) =>
				nameTokens.has(token),
			)
			for (const target of targets) {
				if (isOtherLinux && target.startsWith('linux-')) continue
				group.targets.add(target)
			}
		} else {
			group.unrecognised.push(relativePath)
		}
	}

	const missingFor = (group: AddonGroup) =>
		requiredTargets.filter((target) => (!group.filter || group.filter(target)) && !group.targets.has(target))

	// Some libraries have extra addons for specific platforms alongside a complete one (eg node-hid has HID_hidraw for linux)
	// When a sibling in the same prebuilds folder is complete, assume any others are intentionally limited to the platforms they have binaries for
	for (const [key, group] of groups) {
		if (group.kind !== 'prebuilds' || group.filter) continue
		const completeSibling = Array.from(groups).find(
			([, other]) =>
				other !== group &&
				other.prebuildsDir === group.prebuildsDir &&
				missingFor(other).length === 0 &&
				other.unrecognised.length === 0,
		)
		if (!completeSibling || missingFor(group).length === 0) continue

		const platforms = new Set(Array.from(group.targets).map((target) => target.split('-')[0]))
		group.filter = (target) => platforms.has(target.split('-')[0])
		group.note = `${key} is assumed to be specific to ${Array.from(platforms).sort().join(', ')}, as ${completeSibling[0]} covers every platform`
	}

	const addons: NativeAddonReport[] = []
	for (const [key, group] of groups) {
		const missing = missingFor(group)
		let hint: string | undefined
		if (group.kind === 'platform-package') hint = PLATFORM_PACKAGE_HINT
		else if (group.kind === 'loose') hint = LOOSE_BINARY_HINT

		addons.push({
			key,
			kind: group.kind,
			files: group.files,
			targets: Array.from(group.targets).sort(),
			missing,
			unrecognised: group.unrecognised,
			hint: missing.length || group.unrecognised.length ? hint : undefined,
			note: group.note,
		})
	}
	addons.sort((a, b) => a.key.localeCompare(b.key))

	return {
		addons,
		ok: addons.every((addon) => addon.missing.length === 0 && addon.unrecognised.length === 0),
	}
}

/**
 * Format a report into human readable lines
 */
export function formatPrebuildReport(report: PrebuildReport): string[] {
	const lines: string[] = []
	for (const addon of report.addons) {
		const ok = addon.missing.length === 0 && addon.unrecognised.length === 0
		lines.push(`${ok ? '✔' : '✘'} ${addon.key}: found ${addon.targets.join(', ') || 'nothing'}`)
		if (addon.note) lines.push(`    note: ${addon.note}`)
		if (addon.missing.length) lines.push(`    missing: ${addon.missing.join(', ')}`)
		for (const file of addon.unrecognised) lines.push(`    unrecognised binary: ${file}`)
		if (!ok) {
			for (const file of addon.files) lines.push(`    file: ${file}`)
			if (addon.hint) lines.push(`    ${addon.hint}`)
		}
	}
	return lines
}

/**
 * Print the result of a prebuild check, and throw if any required targets are missing
 */
export function enforcePrebuildCoverage(
	report: PrebuildReport,
	options: {
		ignorePrebuildRules?: boolean
		stdout?: Pick<NodeJS.WriteStream, 'write'>
		stderr?: Pick<NodeJS.WriteStream, 'write'>
	} = {},
): void {
	const stdout = options.stdout ?? process.stdout
	const stderr = options.stderr ?? process.stderr

	if (report.addons.length === 0) {
		stdout.write('Native prebuilds: none found\n')
		return
	}

	const lines = formatPrebuildReport(report)
	if (report.ok) {
		stdout.write(`Native prebuilds:\n${lines.map((line) => `  ${line}\n`).join('')}`)
		return
	}

	const failed = report.addons.filter((addon) => addon.missing.length || addon.unrecognised.length).length
	const label = options.ignorePrebuildRules ? 'PREBUILD WARNING' : 'PREBUILD ERROR'
	stderr.write(
		`${label}: ${failed} native ${failed === 1 ? 'library is' : 'libraries are'} missing binaries for required platforms (${REQUIRED_PREBUILD_TARGETS.join(', ')})\n`,
	)
	stderr.write(lines.map((line) => `  ${line}\n`).join(''))

	if (!options.ignorePrebuildRules) {
		stderr.write('Pass --ignore-prebuild-rules to build anyway.\n')
		throw new PrebuildCoverageError(
			`Prebuild validation failed for ${failed} native ${failed === 1 ? 'library' : 'libraries'}`,
		)
	}
}
