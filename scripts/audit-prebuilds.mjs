#!/usr/bin/env node
// Temporary script to audit already built module packages, checking that their native libraries have binaries for all the required platforms.
// Usage: yarn build && node scripts/audit-prebuilds.mjs <folder-of-extracted-packages> [--verbose]
import fs from 'node:fs/promises'
import path from 'node:path'
import { checkPrebuildCoverage, formatPrebuildReport } from '../dist/scripts/lib/prebuild-check-util.js'

const args = process.argv.slice(2)
const verbose = args.includes('--verbose')
const rootDir = args.find((arg) => !arg.startsWith('--'))
if (!rootDir) {
	console.error('Usage: node scripts/audit-prebuilds.mjs <folder-of-extracted-packages> [--verbose]')
	process.exit(2)
}

async function exists(filePath) {
	return fs
		.stat(filePath)
		.then(() => true)
		.catch(() => false)
}

/** Find the package roots (folders containing companion/manifest.json) within an extracted package folder */
async function findPackageRoots(dir, depth = 0) {
	if (await exists(path.join(dir, 'companion', 'manifest.json'))) return [dir]
	if (depth >= 2) return []

	const roots = []
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		if (entry.isDirectory() && entry.name !== 'node_modules') {
			roots.push(...(await findPackageRoots(path.join(dir, entry.name), depth + 1)))
		}
	}
	return roots
}

const entries = (await fs.readdir(rootDir, { withFileTypes: true })).filter((entry) => entry.isDirectory())
entries.sort((a, b) => a.name.localeCompare(b.name))

let okCount = 0
let nativeCount = 0
const failed = []

for (const entry of entries) {
	const entryDir = path.join(rootDir, entry.name)
	const packageRoots = await findPackageRoots(entryDir)
	if (packageRoots.length === 0) {
		console.log(`? ${entry.name}: no companion/manifest.json found`)
		failed.push(entry.name)
		continue
	}

	for (const packageRoot of packageRoots) {
		const name = path.relative(rootDir, packageRoot)
		let report
		try {
			report = await checkPrebuildCoverage(packageRoot)
		} catch (e) {
			console.log(`? ${name}: failed to check: ${e?.message ?? e}`)
			failed.push(name)
			continue
		}

		if (report.addons.length) nativeCount++

		if (report.ok) {
			okCount++
			if (report.addons.length === 0) {
				if (verbose) console.log(`✔ ${name}: no native code`)
			} else {
				console.log(`✔ ${name}`)
				if (verbose) for (const line of formatPrebuildReport(report)) console.log(`    ${line}`)
			}
		} else {
			failed.push(name)
			console.log(`✘ ${name}`)
			for (const line of formatPrebuildReport(report)) console.log(`    ${line}`)
		}
	}
}

console.log('')
console.log(`Checked ${okCount + failed.length} packages: ${nativeCount} with native code, ${failed.length} failing`)
if (failed.length) {
	console.log('Failing:')
	for (const name of failed) console.log(`  - ${name}`)
	process.exitCode = 1
}
