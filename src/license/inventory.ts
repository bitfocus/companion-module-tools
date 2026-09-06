import { lstat, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import * as esbuild from 'esbuild'

export type ShippedPackageKind = 'project' | 'bundled' | 'external'

export interface ShippedPackage {
	kind: ShippedPackageKind
	name: string
	version?: string
	declaredLicense?: string
	/** Only for the project, the package.json license of its own source, which declaredLicense distributes it under */
	sourceLicense?: string
	/** Where recipients can obtain the source of this package, as required by MPL-2.0 and the GPL family */
	repositoryUrl?: string
	packageRoot: string
	contributingPaths: Set<string>
}

export interface PackageCollection {
	packages: ShippedPackage[]
	diagnostics: string[]
}

export interface LegalText {
	role: 'license' | 'notice' | 'source-comment'
	filename: string
	content: string
	sha256: string
}

export interface ShippedPackageLegalRecord extends ShippedPackage {
	legalTexts: LegalText[]
}

export interface PackageLegalMaterial {
	package: ShippedPackageLegalRecord
	diagnostics: string[]
}

export interface LegalInventory {
	packages: ShippedPackageLegalRecord[]
	diagnostics: string[]
}

/**
 * Per-consumer corrections to what npm packages declare about themselves. These are kept out of this package so that
 * adding one does not need a release of the tooling, and so that each consumer only carries the entries its own
 * dependency tree needs.
 */
export interface LicenseOverrides {
	/**
	 * Licenses for packages which ship no license declaration at all, keyed by exact `name@version`. A declared
	 * license always wins, so an entry here can never hide what a package says about itself.
	 */
	knownPackageLicenses: Record<string, string>
	/**
	 * What the license text of a package actually is, for packages whose declaration is not a valid SPDX expression,
	 * keyed by exact `name@version`. Only consulted when the declaration cannot be parsed, so a correction can never
	 * turn a real license into a more convenient one.
	 */
	correctedPackageLicenses: Record<string, string>
}

/** For consumers which have nothing to correct, and for tests */
export const NO_LICENSE_OVERRIDES: LicenseOverrides = { knownPackageLicenses: {}, correctedPackageLicenses: {} }

export function knownPackageLicense(
	overrides: LicenseOverrides,
	name: string | undefined,
	version: string | undefined,
): string | undefined {
	if (!name || !version) return undefined
	return overrides.knownPackageLicenses[`${name}@${version}`]
}

export function correctedPackageLicense(
	overrides: LicenseOverrides,
	name: string | undefined,
	version: string | undefined,
): string | undefined {
	if (!name || !version) return undefined
	return overrides.correctedPackageLicenses[`${name}@${version}`]
}

export type PackageJson = {
	name?: string
	version?: string
	license?: unknown
	licenses?: unknown
	repository?: unknown
	homepage?: unknown
}

const SHORTHAND_REPOSITORY_HOSTS: Record<string, string> = {
	github: 'https://github.com/',
	gitlab: 'https://gitlab.com/',
	bitbucket: 'https://bitbucket.org/',
}

export function normalizeRepositoryUrl(packageJson: PackageJson): string | undefined {
	const repository = packageJson.repository
	const declared =
		typeof repository === 'string'
			? repository
			: repository && typeof repository === 'object' && typeof (repository as { url?: unknown }).url === 'string'
				? (repository as { url: string }).url
				: undefined

	let url = declared?.trim() ?? ''
	if (url) {
		// npm shorthands, either "user/repo" or "<host>:user/repo"
		if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `${SHORTHAND_REPOSITORY_HOSTS.github}${url}`
		const shorthand = /^([a-z]+):([\w.-]+\/[\w.-]+)$/.exec(url)
		if (shorthand && SHORTHAND_REPOSITORY_HOSTS[shorthand[1]]) {
			url = `${SHORTHAND_REPOSITORY_HOSTS[shorthand[1]]}${shorthand[2]}`
		}

		url = url.replace(/^git\+/, '').replace(/^(?:git|ssh):\/\/(?:git@)?/, 'https://')
		const scpLike = /^git@([^:]+):(.+)$/.exec(url)
		if (scpLike) url = `https://${scpLike[1]}/${scpLike[2]}`
		url = url.replace(/\.git$/, '')
	}

	if (!/^https?:\/\//.test(url)) url = typeof packageJson.homepage === 'string' ? packageJson.homepage.trim() : ''
	return /^https?:\/\//.test(url) ? url : undefined
}

export function normalizeInventoryPath(inputPath: string, ownerRoot: string): string {
	const relativePath = path.relative(ownerRoot, inputPath)
	if (relativePath === '' || relativePath === '.') return '.'
	if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
		return '<outside package root>'
	}

	return relativePath.split(path.sep).join('/')
}

export async function readPackageJson(packageRoot: string): Promise<PackageJson> {
	return JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
}

export function asLicenseString(license: unknown): string | undefined {
	if (typeof license === 'string') return license
	// npm deprecated { type, url } and arrays of it long ago, but older packages are still published with them
	if (Array.isArray(license)) {
		const choices = license.map(asLicenseString).filter((choice) => choice !== undefined)
		if (!choices.length) return undefined
		return choices.length === 1 ? choices[0] : `(${choices.join(' OR ')})` // An array offers a choice of licenses
	}
	if (license && typeof license === 'object') return asLicenseString((license as { type?: unknown }).type)
	return undefined
}

/** Reads a package's license, preferring the current field over the deprecated plural one */
export function declaredLicenseOf(packageJson: PackageJson, overrides: LicenseOverrides): string | undefined {
	return (
		asLicenseString(packageJson.license) ??
		asLicenseString(packageJson.licenses) ??
		// Only for packages declaring nothing at all, so this can never override what a package says about itself
		knownPackageLicense(overrides, packageJson.name, packageJson.version)
	)
}

/**
 * The package a file belongs to, or undefined when it is not inside an installed package. A package owns everything
 * below the directory node_modules resolves it to. Its own subdirectories can hold a package.json marking their
 * module type, sometimes with a name and version, so only this boundary identifies it.
 */
async function findInstalledPackageRoot(inputPath: string): Promise<string | undefined> {
	const segments = inputPath.split(path.sep)
	const lastNodeModules = segments.lastIndexOf('node_modules')
	if (lastNodeModules === -1) return undefined

	const rootIndex = lastNodeModules + 1
	const packageRoot = segments
		.slice(0, segments[rootIndex]?.startsWith('@') ? rootIndex + 2 : rootIndex + 1)
		.join(path.sep)

	try {
		await readPackageJson(packageRoot)
		return packageRoot
	} catch {
		return undefined // Without a package.json this is not a package, so the file counts as project code
	}
}

export function getContributingInputs(metafile: esbuild.Metafile): string[] {
	const inputs = new Set<string>()
	for (const [outputPath, output] of Object.entries(metafile.outputs)) {
		if (!outputPath.endsWith('.js')) continue
		for (const [inputPath, input] of Object.entries(output.inputs)) {
			if (input.bytesInOutput > 0) inputs.add(inputPath)
		}
	}
	return [...inputs]
}

export function packageFromJson(
	kind: ShippedPackageKind,
	packageRoot: string,
	packageJson: PackageJson,
	overrides: LicenseOverrides,
): ShippedPackage {
	return {
		kind,
		name: packageJson.name ?? path.basename(packageRoot),
		version: packageJson.version,
		declaredLicense: declaredLicenseOf(packageJson, overrides),
		repositoryUrl: normalizeRepositoryUrl(packageJson),
		packageRoot,
		contributingPaths: new Set(),
	}
}

export async function collectInstalledPackages(
	nodeModulesDir: string,
	overrides: LicenseOverrides,
): Promise<ShippedPackage[]> {
	const packages: ShippedPackage[] = []

	async function scan(currentNodeModulesDir: string): Promise<void> {
		let entries
		try {
			entries = await readdir(currentNodeModulesDir, { withFileTypes: true })
		} catch {
			return
		}

		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name === '.bin' || entry.isSymbolicLink()) continue
			if (entry.name.startsWith('@')) {
				if (!entry.isDirectory()) continue
				await scanScopedPackages(path.join(currentNodeModulesDir, entry.name))
				continue
			}
			if (!entry.isDirectory()) continue
			await scanPackage(path.join(currentNodeModulesDir, entry.name))
		}
	}

	async function scanScopedPackages(scopeDir: string): Promise<void> {
		const entries = await readdir(scopeDir, { withFileTypes: true })
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.isDirectory() && !entry.isSymbolicLink()) await scanPackage(path.join(scopeDir, entry.name))
		}
	}

	async function scanPackage(packageRoot: string): Promise<void> {
		try {
			packages.push(packageFromJson('external', packageRoot, await readPackageJson(packageRoot), overrides))
		} catch {
			return
		}
		await scan(path.join(packageRoot, 'node_modules'))
	}

	await scan(nodeModulesDir)
	return packages
}

const MAX_LEGAL_FILE_SIZE = 1024 * 1024

export function normalizeLegalText(content: string): string {
	return content.replace(/\r\n/g, '\n').trim()
}

function sha256(content: string): string {
	return createHash('sha256').update(content).digest('hex')
}

export function isPathInside(childPath: string, parentPath: string): boolean {
	const relativePath = path.relative(parentPath, childPath)
	return (
		relativePath === '' ||
		(!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath))
	)
}

function legalRole(filename: string): LegalText['role'] | undefined {
	if (/^(license|licence|copying)/i.test(filename)) return 'license'
	// Where a package vendors code it did not write, this is where it carries those licenses
	if (/^third[-_. ]?party/i.test(filename)) return 'license'
	if (/^notice/i.test(filename)) return 'notice'
	return undefined
}

async function readLegalText(
	filePath: string,
	packageRoot: string,
	role: LegalText['role'],
): Promise<LegalText | undefined> {
	const linkStat = await lstat(filePath)
	if (linkStat.isSymbolicLink()) return undefined
	const fileStat = await stat(filePath)
	if (!fileStat.isFile() || fileStat.size > MAX_LEGAL_FILE_SIZE) return undefined
	const rawContent = await readFile(filePath, 'utf8')
	if (rawContent.includes('\0')) return undefined
	const content = normalizeLegalText(rawContent)
	if (!content) return undefined
	return { role, filename: normalizeInventoryPath(filePath, packageRoot), content, sha256: sha256(content) }
}

function sourceLoader(filename: string): esbuild.Loader | undefined {
	switch (path.extname(filename).toLowerCase()) {
		case '.js':
		case '.mjs':
		case '.cjs':
			return 'js'
		case '.ts':
			return 'ts'
		case '.tsx':
			return 'tsx'
		default:
			return undefined
	}
}

export async function collectPackageLegalMaterial(packageInfo: ShippedPackage): Promise<PackageLegalMaterial> {
	const diagnostics: string[] = []
	const candidateFiles = new Map<string, LegalText['role']>()
	for (const entry of await readdir(packageInfo.packageRoot, { withFileTypes: true })) {
		if (!entry.isFile()) continue
		const role = legalRole(entry.name)
		if (role) candidateFiles.set(entry.name, role)
	}

	const seeLicenseMatch = /^SEE LICENSE IN (.+)$/i.exec(packageInfo.declaredLicense ?? '')
	if (seeLicenseMatch) {
		const explicitPath = path.resolve(packageInfo.packageRoot, seeLicenseMatch[1])
		if (!isPathInside(explicitPath, packageInfo.packageRoot)) {
			diagnostics.push(`Ignoring license file outside package root: ${seeLicenseMatch[1]}`)
		} else {
			candidateFiles.set(normalizeInventoryPath(explicitPath, packageInfo.packageRoot), 'license')
		}
	}

	const legalTexts: LegalText[] = []
	for (const [filename, role] of [...candidateFiles.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		try {
			const legalText = await readLegalText(path.join(packageInfo.packageRoot, filename), packageInfo.packageRoot, role)
			if (legalText) legalTexts.push(legalText)
			else diagnostics.push(`Ignoring unreadable, binary, or oversized legal file: ${filename}`)
		} catch {
			diagnostics.push(`Ignoring unreadable legal file: ${filename}`)
		}
	}

	if (!legalTexts.some((text) => text.role === 'license')) {
		for (const sourcePath of [...packageInfo.contributingPaths].sort()) {
			const loader = sourceLoader(sourcePath)
			if (!loader) {
				diagnostics.push(`Ignoring unsupported source file for legal comments: ${sourcePath}`)
				continue
			}
			try {
				const source = await readFile(path.join(packageInfo.packageRoot, sourcePath), 'utf8')
				const result = await esbuild.transform(source, { loader, legalComments: 'external' })
				if (result.legalComments) {
					const content = normalizeLegalText(result.legalComments)
					if (content) {
						legalTexts.push({
							role: 'source-comment',
							filename: sourcePath,
							content,
							sha256: sha256(content),
						})
					}
				}
			} catch {
				diagnostics.push(`Ignoring unreadable source file for legal comments: ${sourcePath}`)
			}
		}
	}

	const uniqueTexts = new Map<string, LegalText>()
	for (const legalText of legalTexts) {
		const key =
			legalText.role === 'source-comment'
				? `${legalText.role}:${legalText.sha256}`
				: `${legalText.role}:${legalText.filename}:${legalText.sha256}`
		uniqueTexts.set(key, legalText)
	}
	return { package: { ...packageInfo, legalTexts: [...uniqueTexts.values()] }, diagnostics }
}

function comparePackages(a: ShippedPackageLegalRecord, b: ShippedPackageLegalRecord): number {
	if (a.kind === 'project' && b.kind !== 'project') return -1
	if (a.kind !== 'project' && b.kind === 'project') return 1
	return a.name.localeCompare(b.name) || (a.version ?? '').localeCompare(b.version ?? '')
}

function packageName(packageInfo: ShippedPackageLegalRecord): string {
	return packageInfo.version ? `${packageInfo.name}@${packageInfo.version}` : packageInfo.name
}

function renderLegalFile(inventory: LegalInventory, roles: LegalText['role'][]): string | undefined {
	const groupedTexts = new Map<string, { text: LegalText; packages: Map<string, ShippedPackageLegalRecord> }>()
	for (const packageInfo of inventory.packages) {
		for (const text of packageInfo.legalTexts) {
			if (!roles.includes(text.role)) continue
			const group = groupedTexts.get(text.sha256) ?? { text, packages: new Map() }
			const packageKey = `${packageInfo.kind === 'project' ? 'project' : 'dependency'}:${packageName(packageInfo)}:${packageInfo.declaredLicense ?? ''}`
			group.packages.set(packageKey, packageInfo)
			groupedTexts.set(text.sha256, group)
		}
	}
	if (!groupedTexts.size) return undefined

	const sections = [...groupedTexts.values()].sort((a, b) =>
		comparePackages(
			[...a.packages.values()].sort(comparePackages)[0],
			[...b.packages.values()].sort(comparePackages)[0],
		),
	)
	const separator = '-'.repeat(80)
	const renderedSections = sections.map((section) => {
		const packages = [...section.packages.values()].sort(comparePackages)
		const packageList = packages
			.map((packageInfo) => {
				const label = `${packageName(packageInfo)} — ${packageInfo.declaredLicense ?? 'UNKNOWN'}`
				// Tells recipients where to obtain the source, which MPL-2.0 and the GPL family require
				return packageInfo.repositoryUrl ? `${label} (${packageInfo.repositoryUrl})` : label
			})
			.join(', ')
		return `Packages: ${packageList}\n${separator}\n${normalizeLegalText(section.text.content)}`
	})
	return `${renderedSections.join('\n\n')}\n`
}

export function renderLicenseFile(inventory: LegalInventory): string {
	return renderLegalFile(inventory, ['license', 'source-comment']) ?? ''
}

export function renderNoticeFile(inventory: LegalInventory): string | undefined {
	return renderLegalFile(inventory, ['notice'])
}

export async function writeLegalArtifacts(outputDir: string, inventory: LegalInventory): Promise<void> {
	await writeFile(path.join(outputDir, 'LICENSE'), renderLicenseFile(inventory))
	const notice = renderNoticeFile(inventory)
	const noticePath = path.join(outputDir, 'NOTICE')
	if (notice) await writeFile(noticePath, notice)
	else await rm(noticePath, { force: true })
}

const kindPriority: Record<ShippedPackageKind, number> = {
	project: 0,
	bundled: 1,
	external: 2,
}

export async function createLegalInventory(packages: ShippedPackage[]): Promise<LegalInventory> {
	const mergedPackages = new Map<string, ShippedPackage>()
	for (const packageInfo of packages) {
		const existing = mergedPackages.get(packageInfo.packageRoot)
		if (!existing) {
			mergedPackages.set(packageInfo.packageRoot, {
				...packageInfo,
				contributingPaths: new Set(packageInfo.contributingPaths),
			})
			continue
		}
		for (const sourcePath of packageInfo.contributingPaths) existing.contributingPaths.add(sourcePath)
		if (kindPriority[packageInfo.kind] < kindPriority[existing.kind]) existing.kind = packageInfo.kind
	}

	const diagnostics: string[] = []
	const legalRecords: ShippedPackageLegalRecord[] = []
	for (const packageInfo of mergedPackages.values()) {
		const material = await collectPackageLegalMaterial(packageInfo)
		legalRecords.push(material.package)
		diagnostics.push(...material.diagnostics)
	}
	return { packages: legalRecords, diagnostics }
}

/** Identifies the project whose bundle is being inventoried, and the license it ships under */
export interface ProjectIdentity {
	/**
	 * Directories which may contribute code. A file inside one of these, and not inside a node_modules directory, is
	 * the project's own code; anything outside all of them is reported as a diagnostic rather than attributed.
	 * A single-package project passes just its own directory, a monorepo passes its workspace root.
	 */
	projectRoots: string[]
	/** The package.json identifying the project, which its own code is attributed to */
	packageRoot: string
	/**
	 * What the project is called in the generated files, for a project whose package.json name is not the name the
	 * built artifact ships as. Undefined uses the name from that package.json.
	 */
	name: string | undefined
	/**
	 * The license the built artifact is distributed under, which is what its dependencies must be compatible with.
	 * Undefined falls back to the license declared by the project package.json.
	 */
	distributionLicense: string | undefined
}

/**
 * Attributes each file which contributed to a bundle to the package that owns it. Callers which bundle with esbuild
 * pass a metafile to collectMetafilePackages instead; this is the entrypoint for every other bundler.
 */
export async function collectPackagesFromInputPaths(
	inputPaths: string[],
	project: ProjectIdentity,
	overrides: LicenseOverrides,
): Promise<PackageCollection> {
	const projectPackageJson = await readPackageJson(project.packageRoot)
	const projectLicense = project.distributionLicense ?? declaredLicenseOf(projectPackageJson, overrides)
	const packages = new Map<string, ShippedPackage>()
	const diagnostics: string[] = []

	for (const inputPath of inputPaths) {
		// Resolve ownership using the logical node_modules path. Realpath would turn linked dependencies into paths
		// outside the project roots and incorrectly classify them as project code.
		const installedRoot = await findInstalledPackageRoot(inputPath)
		if (!installedRoot && !project.projectRoots.some((root) => isPathInside(inputPath, root))) {
			diagnostics.push(`Ignoring bundle input outside the project: ${inputPath}`)
			continue
		}

		const packageRoot = installedRoot ?? project.packageRoot
		const kind: ShippedPackageKind = installedRoot ? 'bundled' : 'project'
		const key = `${kind}:${packageRoot}`
		let packageInfo = packages.get(key)
		if (!packageInfo) {
			const packageJson = installedRoot ? await readPackageJson(installedRoot) : projectPackageJson
			packageInfo = {
				kind,
				name: (kind === 'project' ? project.name : undefined) ?? packageJson.name ?? path.basename(packageRoot),
				version: packageJson.version,
				declaredLicense:
					kind === 'project' ? asLicenseString(projectLicense) : declaredLicenseOf(packageJson, overrides),
				sourceLicense: kind === 'project' ? declaredLicenseOf(projectPackageJson, overrides) : undefined,
				repositoryUrl: normalizeRepositoryUrl(packageJson),
				packageRoot,
				contributingPaths: new Set(),
			}
			packages.set(key, packageInfo)
		}
		packageInfo.contributingPaths.add(normalizeInventoryPath(inputPath, packageRoot))
	}

	return { packages: [...packages.values()], diagnostics }
}

/** Attributes the inputs of an esbuild metafile to the packages that own them */
export async function collectMetafilePackages(
	metafile: esbuild.Metafile,
	/** The directory metafile input paths are relative to, which is esbuild's absWorkingDir */
	absWorkingDir: string,
	project: ProjectIdentity,
	overrides: LicenseOverrides,
): Promise<PackageCollection> {
	const inputPaths: string[] = []
	const diagnostics: string[] = []
	for (const input of getContributingInputs(metafile)) {
		if (input.startsWith('<')) {
			diagnostics.push(`Ignoring virtual esbuild input: ${input}`)
			continue
		}
		inputPaths.push(path.resolve(absWorkingDir, input))
	}

	const collection = await collectPackagesFromInputPaths(inputPaths, project, overrides)
	return { packages: collection.packages, diagnostics: [...diagnostics, ...collection.diagnostics] }
}
