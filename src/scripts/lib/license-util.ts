import { lstat, readdir, realpath, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import * as esbuild from 'esbuild'

export type ShippedPackageKind = 'project' | 'bundled' | 'external'

export interface ShippedPackage {
	kind: ShippedPackageKind
	name: string
	version?: string
	declaredLicense?: string
	packageRoot: string
	contributingPaths: Set<string>
}

export interface MetafilePackageCollection {
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

type PackageJson = {
	name?: string
	version?: string
	license?: unknown
}

export function normalizeInventoryPath(inputPath: string, ownerRoot: string): string {
	const relativePath = path.relative(ownerRoot, inputPath)
	if (relativePath === '' || relativePath === '.') return '.'
	if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
		return '<outside package root>'
	}

	return relativePath.split(path.sep).join('/')
}

async function readPackageJson(packageRoot: string): Promise<PackageJson> {
	return JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
}

async function findPackageRoot(inputPath: string, moduleDir: string): Promise<string | undefined> {
	const nodeModulesDir = path.join(moduleDir, 'node_modules')
	let currentDir = path.dirname(inputPath)

	while (currentDir.startsWith(`${nodeModulesDir}${path.sep}`)) {
		try {
			await readFile(path.join(currentDir, 'package.json'))
			return currentDir
		} catch {
			currentDir = path.dirname(currentDir)
		}
	}

	return undefined
}

function getContributingInputs(metafile: esbuild.Metafile): string[] {
	const inputs = new Set<string>()
	for (const [outputPath, output] of Object.entries(metafile.outputs)) {
		if (!outputPath.endsWith('.js')) continue
		for (const [inputPath, input] of Object.entries(output.inputs)) {
			if (input.bytesInOutput > 0) inputs.add(inputPath)
		}
	}
	return [...inputs]
}

function packageFromJson(kind: ShippedPackageKind, packageRoot: string, packageJson: PackageJson): ShippedPackage {
	return {
		kind,
		name: packageJson.name ?? path.basename(packageRoot),
		version: packageJson.version,
		declaredLicense: typeof packageJson.license === 'string' ? packageJson.license : undefined,
		packageRoot,
		contributingPaths: new Set(),
	}
}

export async function collectInstalledPackages(nodeModulesDir: string): Promise<ShippedPackage[]> {
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
			packages.push(packageFromJson('external', packageRoot, await readPackageJson(packageRoot)))
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

function isPathInside(childPath: string, parentPath: string): boolean {
	const relativePath = path.relative(parentPath, childPath)
	return (
		relativePath === '' ||
		(!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath))
	)
}

function legalRole(filename: string): LegalText['role'] | undefined {
	if (/^(license|licence|copying)/i.test(filename)) return 'license'
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
	const groupedTexts = new Map<string, { text: LegalText; packages: ShippedPackageLegalRecord[] }>()
	for (const packageInfo of inventory.packages) {
		for (const text of packageInfo.legalTexts) {
			if (!roles.includes(text.role)) continue
			const key = `${text.role}:${text.sha256}`
			const group = groupedTexts.get(key) ?? { text, packages: [] }
			group.packages.push(packageInfo)
			groupedTexts.set(key, group)
		}
	}
	if (!groupedTexts.size) return undefined

	const sections = [...groupedTexts.values()].sort((a, b) =>
		comparePackages(a.packages.sort(comparePackages)[0], b.packages.sort(comparePackages)[0]),
	)
	const separator = '-'.repeat(80)
	const renderedSections = sections.map((section) => {
		const packages = section.packages.sort(comparePackages)
		const packageList = packages
			.map((packageInfo) => `${packageName(packageInfo)} — ${packageInfo.declaredLicense ?? 'UNKNOWN'}`)
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

export async function collectMetafilePackages(
	moduleDir: string,
	metafile: esbuild.Metafile,
): Promise<MetafilePackageCollection> {
	const resolvedModuleDir = await realpath(moduleDir)
	const projectPackageJson = await readPackageJson(resolvedModuleDir)
	const manifestJson = JSON.parse(
		await readFile(path.join(resolvedModuleDir, 'companion', 'manifest.json'), 'utf8'),
	) as {
		license?: unknown
	}
	const packages = new Map<string, ShippedPackage>()
	const diagnostics: string[] = []

	for (const input of getContributingInputs(metafile)) {
		if (input.startsWith('<')) {
			diagnostics.push(`Ignoring virtual esbuild input: ${input}`)
			continue
		}

		const inputPath = path.resolve(resolvedModuleDir, input)
		if (!isPathInside(inputPath, resolvedModuleDir)) {
			diagnostics.push(`Ignoring esbuild input outside module directory: ${input}`)
			continue
		}

		// Resolve ownership using logical node_modules path. Realpath would turn linked
		// dependencies into paths outside moduleDir and incorrectly classify them as project code.
		const packageRoot = (await findPackageRoot(inputPath, resolvedModuleDir)) ?? resolvedModuleDir
		const packageJson = packageRoot === resolvedModuleDir ? projectPackageJson : await readPackageJson(packageRoot)
		const kind: ShippedPackageKind = packageRoot === resolvedModuleDir ? 'project' : 'bundled'
		const key = `${kind}:${packageRoot}`
		let packageInfo = packages.get(key)
		if (!packageInfo) {
			packageInfo = {
				kind,
				name: packageJson.name ?? path.basename(packageRoot),
				version: packageJson.version,
				declaredLicense:
					kind === 'project'
						? typeof manifestJson.license === 'string'
							? manifestJson.license
							: typeof packageJson.license === 'string'
								? packageJson.license
								: undefined
						: typeof packageJson.license === 'string'
							? packageJson.license
							: undefined,
				packageRoot,
				contributingPaths: new Set(),
			}
			packages.set(key, packageInfo)
		}
		packageInfo.contributingPaths.add(normalizeInventoryPath(inputPath, packageRoot))
	}

	return { packages: [...packages.values()], diagnostics }
}
