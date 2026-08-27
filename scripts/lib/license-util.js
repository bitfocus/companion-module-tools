import { lstat, readdir, realpath, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { knownPackageLicense } from './known-package-licenses.js'

/**
 * @typedef {'project' | 'bundled' | 'external'} ShippedPackageKind
 */

/**
 * @typedef {object} ShippedPackage
 * @property {ShippedPackageKind} kind
 * @property {string} name
 * @property {string | undefined} [version]
 * @property {string | undefined} [declaredLicense]
 * @property {string | undefined} [sourceLicense] Only for the project, the package.json license of its own source, which declaredLicense distributes it under
 * @property {string | undefined} [repositoryUrl] Where recipients can obtain the source of this package, as required by MPL-2.0 and the GPL family
 * @property {string} packageRoot
 * @property {Set<string>} contributingPaths
 */

/**
 * @typedef {object} ShippedPackageCollection
 * @property {ShippedPackage[]} packages
 * @property {string[]} diagnostics
 */

/**
 * @typedef {object} LegalText
 * @property {'license' | 'notice' | 'source-comment'} role
 * @property {string} filename
 * @property {string} content
 * @property {string} sha256
 */

/**
 * @typedef {ShippedPackage & { legalTexts: LegalText[] }} ShippedPackageLegalRecord
 */

/**
 * @typedef {object} PackageLegalMaterial
 * @property {ShippedPackageLegalRecord} package
 * @property {string[]} diagnostics
 */

/**
 * @typedef {object} LegalInventory
 * @property {ShippedPackageLegalRecord[]} packages
 * @property {string[]} diagnostics
 */

/**
 * @typedef {object} PackageJson
 * @property {string} [name]
 * @property {string} [version]
 * @property {unknown} [license]
 * @property {unknown} [licenses]
 * @property {unknown} [repository]
 * @property {unknown} [homepage]
 * @property {unknown} [dependencies]
 * @property {unknown} [optionalDependencies]
 * @property {unknown} [peerDependencies]
 */

/** @type {Record<string, string>} */
const SHORTHAND_REPOSITORY_HOSTS = {
	github: 'https://github.com/',
	gitlab: 'https://gitlab.com/',
	bitbucket: 'https://bitbucket.org/',
}

/**
 * @param {PackageJson} packageJson
 * @returns {string | undefined}
 */
export function normalizeRepositoryUrl(packageJson) {
	const repository = packageJson.repository
	const declared =
		typeof repository === 'string'
			? repository
			: repository && typeof repository === 'object' && typeof repository.url === 'string'
				? repository.url
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

/**
 * @param {string} inputPath
 * @param {string} ownerRoot
 * @returns {string}
 */
export function normalizeInventoryPath(inputPath, ownerRoot) {
	const relativePath = path.relative(ownerRoot, inputPath)
	if (relativePath === '' || relativePath === '.') return '.'
	if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
		return '<outside package root>'
	}

	return relativePath.split(path.sep).join('/')
}

/**
 * @param {string} packageRoot
 * @returns {Promise<PackageJson>}
 */
async function readPackageJson(packageRoot) {
	return JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
}

/**
 * @param {unknown} license
 * @returns {string | undefined}
 */
function asLicenseString(license) {
	if (typeof license === 'string') return license
	// npm deprecated { type, url } and arrays of it long ago, but older packages are still published with them
	if (Array.isArray(license)) {
		const choices = license.map(asLicenseString).filter((choice) => choice !== undefined)
		if (!choices.length) return undefined
		return choices.length === 1 ? choices[0] : `(${choices.join(' OR ')})` // An array offers a choice of licenses
	}
	if (license && typeof license === 'object') return asLicenseString(license.type)
	return undefined
}

/**
 * Reads a package's license, preferring the current field over the deprecated plural one
 * @param {PackageJson} packageJson
 * @returns {string | undefined}
 */
function declaredLicenseOf(packageJson) {
	return (
		asLicenseString(packageJson.license) ??
		asLicenseString(packageJson.licenses) ??
		// Only for packages declaring nothing at all, so this can never override what a package says about itself
		knownPackageLicense(packageJson.name, packageJson.version)
	)
}

/**
 * @param {string} moduleDir
 * @returns {Promise<unknown>}
 */
async function readManifestLicense(moduleDir) {
	try {
		const manifest = JSON.parse(await readFile(path.join(moduleDir, 'companion', 'manifest.json'), 'utf8'))
		return manifest.license
	} catch {
		return undefined // Modules without a readable manifest fall back to the package.json license
	}
}

/**
 * Resolve where node would load `name` from when it is required by code in `fromDir`, by walking up the node_modules
 * chain. require.resolve is not usable here, it fails for packages which declare no main and for packages whose
 * exports map does not expose a bare entry. The logical path is returned rather than the realpath, so that linked
 * dependencies keep the identity node_modules gave them.
 *
 * @param {string} fromDir
 * @param {string} name
 * @returns {Promise<string | undefined>}
 */
async function resolvePackageDir(fromDir, name) {
	let currentDir = fromDir
	for (;;) {
		// A node_modules directory never contains a nested node_modules of its own
		if (path.basename(currentDir) !== 'node_modules') {
			const candidate = path.join(currentDir, 'node_modules', name)
			try {
				await readPackageJson(candidate)
				return candidate
			} catch {
				// Not installed at this level, keep walking up
			}
		}

		const parentDir = path.dirname(currentDir)
		if (parentDir === currentDir) return undefined
		currentDir = parentDir
	}
}

/**
 * The dependency names a package pulls in at runtime. devDependencies are deliberately absent, npm and yarn never
 * install them transitively and nothing bundles them, so they are not part of what ships.
 *
 * @param {PackageJson} packageJson
 * @returns {{ name: string, optional: boolean }[]}
 */
function dependencyNames(packageJson) {
	/** @type {{ name: string, optional: boolean }[]} */
	const names = []

	/**
	 * @param {unknown} value
	 * @param {boolean} optional
	 */
	const record = (value, optional) => {
		if (!value || typeof value !== 'object') return
		for (const name of Object.keys(value)) names.push({ name, optional })
	}

	record(packageJson.dependencies, false)
	// Optional and peer dependencies only ship when they actually resolved on disk, so a missing one is not a problem
	record(packageJson.optionalDependencies, true)
	record(packageJson.peerDependencies, true)
	return names
}

/**
 * @param {ShippedPackageKind} kind
 * @param {string} packageRoot
 * @param {PackageJson} packageJson
 * @returns {ShippedPackage}
 */
function packageFromJson(kind, packageRoot, packageJson) {
	return {
		kind,
		name: packageJson.name ?? path.basename(packageRoot),
		version: packageJson.version,
		declaredLicense: declaredLicenseOf(packageJson),
		repositoryUrl: normalizeRepositoryUrl(packageJson),
		packageRoot,
		contributingPaths: new Set(),
	}
}

/**
 * @param {string} nodeModulesDir
 * @returns {Promise<ShippedPackage[]>}
 */
export async function collectInstalledPackages(nodeModulesDir) {
	/** @type {ShippedPackage[]} */
	const packages = []

	/**
	 * @param {string} currentNodeModulesDir
	 * @returns {Promise<void>}
	 */
	async function scan(currentNodeModulesDir) {
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

	/**
	 * @param {string} scopeDir
	 * @returns {Promise<void>}
	 */
	async function scanScopedPackages(scopeDir) {
		const entries = await readdir(scopeDir, { withFileTypes: true })
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.isDirectory() && !entry.isSymbolicLink()) await scanPackage(path.join(scopeDir, entry.name))
		}
	}

	/**
	 * @param {string} packageRoot
	 * @returns {Promise<void>}
	 */
	async function scanPackage(packageRoot) {
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

/**
 * @param {string} content
 * @returns {string}
 */
export function normalizeLegalText(content) {
	return content.replace(/\r\n/g, '\n').trim()
}

/**
 * @param {string} content
 * @returns {string}
 */
function sha256(content) {
	return createHash('sha256').update(content).digest('hex')
}

/**
 * @param {string} childPath
 * @param {string} parentPath
 * @returns {boolean}
 */
function isPathInside(childPath, parentPath) {
	const relativePath = path.relative(parentPath, childPath)
	return (
		relativePath === '' ||
		(!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath))
	)
}

/**
 * @param {string} filename
 * @returns {LegalText['role'] | undefined}
 */
function legalRole(filename) {
	if (/^(license|licence|copying)/i.test(filename)) return 'license'
	if (/^notice/i.test(filename)) return 'notice'
	return undefined
}

/**
 * @param {string} filePath
 * @param {string} packageRoot
 * @param {LegalText['role']} role
 * @returns {Promise<LegalText | undefined>}
 */
async function readLegalText(filePath, packageRoot, role) {
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

/**
 * @param {ShippedPackage} packageInfo
 * @returns {Promise<PackageLegalMaterial>}
 */
export async function collectPackageLegalMaterial(packageInfo) {
	/** @type {string[]} */
	const diagnostics = []
	/** @type {Map<string, LegalText['role']>} */
	const candidateFiles = new Map()
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

	/** @type {LegalText[]} */
	const legalTexts = []
	for (const [filename, role] of [...candidateFiles.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		try {
			const legalText = await readLegalText(path.join(packageInfo.packageRoot, filename), packageInfo.packageRoot, role)
			if (legalText) legalTexts.push(legalText)
			else diagnostics.push(`Ignoring unreadable, binary, or oversized legal file: ${filename}`)
		} catch {
			diagnostics.push(`Ignoring unreadable legal file: ${filename}`)
		}
	}

	// Where a package ships no license file at all, the esbuild build scrapes the `/*! ... */` banners out of the
	// sources it bundled. Neither esbuild nor the set of bundled files is available here, so report it instead.
	if (!legalTexts.some((text) => text.role === 'license')) {
		diagnostics.push(
			`No license file found in package: ${packageInfo.name}${packageInfo.version ? `@${packageInfo.version}` : ''}`,
		)
	}

	/** @type {Map<string, LegalText>} */
	const uniqueTexts = new Map()
	for (const legalText of legalTexts) {
		const key =
			legalText.role === 'source-comment'
				? `${legalText.role}:${legalText.sha256}`
				: `${legalText.role}:${legalText.filename}:${legalText.sha256}`
		uniqueTexts.set(key, legalText)
	}
	return { package: { ...packageInfo, legalTexts: [...uniqueTexts.values()] }, diagnostics }
}

/**
 * @param {ShippedPackageLegalRecord} a
 * @param {ShippedPackageLegalRecord} b
 * @returns {number}
 */
function comparePackages(a, b) {
	if (a.kind === 'project' && b.kind !== 'project') return -1
	if (a.kind !== 'project' && b.kind === 'project') return 1
	return a.name.localeCompare(b.name) || (a.version ?? '').localeCompare(b.version ?? '')
}

/**
 * @param {ShippedPackageLegalRecord} packageInfo
 * @returns {string}
 */
function packageName(packageInfo) {
	return packageInfo.version ? `${packageInfo.name}@${packageInfo.version}` : packageInfo.name
}

/**
 * @param {LegalInventory} inventory
 * @param {LegalText['role'][]} roles
 * @returns {string | undefined}
 */
function renderLegalFile(inventory, roles) {
	/** @type {Map<string, { text: LegalText, packages: Map<string, ShippedPackageLegalRecord> }>} */
	const groupedTexts = new Map()
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

/**
 * @param {LegalInventory} inventory
 * @returns {string}
 */
export function renderLicenseFile(inventory) {
	return renderLegalFile(inventory, ['license', 'source-comment']) ?? ''
}

/**
 * @param {LegalInventory} inventory
 * @returns {string | undefined}
 */
export function renderNoticeFile(inventory) {
	return renderLegalFile(inventory, ['notice'])
}

/**
 * @param {string} outputDir
 * @param {LegalInventory} inventory
 * @returns {Promise<void>}
 */
export async function writeLegalArtifacts(outputDir, inventory) {
	await writeFile(path.join(outputDir, 'LICENSE'), renderLicenseFile(inventory))
	const notice = renderNoticeFile(inventory)
	const noticePath = path.join(outputDir, 'NOTICE')
	if (notice) await writeFile(noticePath, notice)
	else await rm(noticePath, { force: true })
}

/** @type {Record<ShippedPackageKind, number>} */
const kindPriority = {
	project: 0,
	bundled: 1,
	external: 2,
}

/**
 * @param {ShippedPackage[]} packages
 * @returns {Promise<LegalInventory>}
 */
export async function createLegalInventory(packages) {
	/** @type {Map<string, ShippedPackage>} */
	const mergedPackages = new Map()
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

	/** @type {string[]} */
	const diagnostics = []
	/** @type {ShippedPackageLegalRecord[]} */
	const legalRecords = []
	for (const packageInfo of mergedPackages.values()) {
		const material = await collectPackageLegalMaterial(packageInfo)
		legalRecords.push(material.package)
		diagnostics.push(...material.diagnostics)
	}
	return { packages: legalRecords, diagnostics }
}

/**
 * The names a module's build-config.cjs declares as externals. Only the object form is read, matching what the build
 * itself installs into the package as dependencies.
 *
 * @param {string} moduleDir
 * @returns {string[]}
 */
export function readExternalNames(moduleDir) {
	let buildConfig
	try {
		buildConfig = createRequire(path.join(moduleDir, 'package.json'))(path.join(moduleDir, 'build-config.cjs'))
	} catch {
		return [] // Modules without a build-config.cjs bundle everything
	}

	const externals = Array.isArray(buildConfig.externals)
		? buildConfig.externals
		: buildConfig.externals
			? [buildConfig.externals]
			: []
	const names = []
	for (const group of externals) {
		if (group && typeof group === 'object') names.push(...Object.keys(group))
	}
	return names
}

/**
 * @param {string} moduleDir
 * @returns {Promise<LegalInventory>}
 */
export async function analyzeShippedLegalInventory(moduleDir) {
	const shippedPackages = await collectProductionPackages(moduleDir, readExternalNames(moduleDir))
	const inventory = await createLegalInventory(shippedPackages.packages)
	return { ...inventory, diagnostics: [...shippedPackages.diagnostics, ...inventory.diagnostics] }
}

/**
 * The set of packages which ship inside a built module. The esbuild build reads this out of the bundler metafile, so
 * it sees exactly the files which made it into the bundle. webpack exposes no equivalent to a detached `npx webpack`,
 * so the production dependency tree is walked instead. That is a superset of what actually gets bundled, anything
 * tree-shaken away is still reported.
 *
 * @param {string} moduleDir
 * @param {string[]} [externalNames] Names the build treats as externals, which ship beside the bundle rather than in it
 * @returns {Promise<ShippedPackageCollection>}
 */
export async function collectProductionPackages(moduleDir, externalNames = []) {
	const resolvedModuleDir = await realpath(moduleDir)
	const projectPackageJson = await readPackageJson(resolvedModuleDir)
	/** @type {ShippedPackage[]} */
	const packages = []
	/** @type {string[]} */
	const diagnostics = []

	// The manifest license is what the packaged module is distributed as, which is what its dependencies must fit.
	// package.json only licenses the module's own source, so it is a fallback for modules not declaring the other.
	const projectLicense = (await readManifestLicense(resolvedModuleDir)) ?? declaredLicenseOf(projectPackageJson)

	packages.push({
		kind: 'project',
		name: projectPackageJson.name ?? path.basename(resolvedModuleDir),
		version: projectPackageJson.version,
		declaredLicense: asLicenseString(projectLicense),
		sourceLicense: declaredLicenseOf(projectPackageJson),
		repositoryUrl: normalizeRepositoryUrl(projectPackageJson),
		packageRoot: resolvedModuleDir,
		contributingPaths: new Set(),
	})

	const externalNameSet = new Set(externalNames)
	const visited = new Set([resolvedModuleDir])
	/** @type {{ dir: string, packageJson: PackageJson }[]} */
	const deferredExternals = []

	/**
	 * @param {ShippedPackageKind} kind
	 * @param {{ dir: string, packageJson: PackageJson }[]} roots
	 * @param {boolean} stopAtExternals
	 * @returns {Promise<void>}
	 */
	async function walk(kind, roots, stopAtExternals) {
		let queue = roots
		while (queue.length) {
			/** @type {{ dir: string, packageJson: PackageJson }[]} */
			const nextQueue = []
			for (const entry of queue) {
				for (const dependency of dependencyNames(entry.packageJson)) {
					const packageRoot = await resolvePackageDir(entry.dir, dependency.name)
					if (!packageRoot) {
						if (!dependency.optional) {
							diagnostics.push(
								`Ignoring dependency which is not installed: ${dependency.name} (required by ${entry.packageJson.name ?? entry.dir})`,
							)
						}
						continue
					}
					if (visited.has(packageRoot)) continue

					const packageJson = await readPackageJson(packageRoot)
					// The bundler externalises a name wherever it is required, so an external and everything below it
					// is installed beside the bundle rather than built into it. Deferred rather than taken now, as a
					// package an external depends on may still be reachable by a path which does bundle it.
					if (stopAtExternals && externalNameSet.has(dependency.name)) {
						deferredExternals.push({ dir: packageRoot, packageJson })
						continue
					}

					visited.add(packageRoot)
					packages.push(packageFromJson(kind, packageRoot, packageJson))
					nextQueue.push({ dir: packageRoot, packageJson })
				}
			}
			queue = nextQueue
		}
	}

	// What the bundler builds into main.js, stopping wherever an external takes over
	await walk('bundled', [{ dir: resolvedModuleDir, packageJson: projectPackageJson }], true)

	/** @type {{ dir: string, packageJson: PackageJson }[]} */
	const externalRoots = []
	for (const root of deferredExternals) {
		if (visited.has(root.dir)) continue // Already reached by a path which bundles it, which is the stricter answer
		visited.add(root.dir)
		packages.push(packageFromJson('external', root.dir, root.packageJson))
		externalRoots.push(root)
	}
	// The externals and their own dependencies, which are installed alongside the module and loaded at runtime
	await walk('external', externalRoots, false)

	return { packages, diagnostics }
}
