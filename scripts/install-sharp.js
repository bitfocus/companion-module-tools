#!/usr/bin/env node
// The zx shebang doesn't resolve dependencies correctly
import 'zx/globals'

import prebuildInstall from 'prebuild-install'
import prebuildUtil from 'prebuild-install/util.js'

const installPlatforms = [
	'darwin-x64',
	'darwin-arm64',
	// TODO missing linux-arm (v7)
	'linux-arm64',
	'linux-x64',
	//   'linuxmusl-x64',
	//   'linuxmusl-arm64',
	//   'win32-ia32',
	'win32-x64',
]

const cwd = process.cwd()

const sharpDir = argv._[0]
if (!sharpDir) throw new Error('Missing sharpDir')

// const sharpDir = await findModuleDir(require.resolve('sharp'))
const sharpPackageJson = JSON.parse(await fs.readFile(path.join(sharpDir, 'package.json')))
console.log(`Found sharp v${sharpPackageJson.version}`)

await fs.rm('pkg/sharp', { recursive: true })

await fs.mkdir('pkg/sharp')
await fs.mkdir(`pkg/sharp/prebuilds`)
await fs.mkdir(`pkg/sharp/tmp`)

await fs.copy(path.join(sharpDir, 'vendor'), 'pkg/sharp/vendor', { recursive: true })

cd(sharpDir)

console.log('Install vendor')
for (const platform of installPlatforms) {
	const parts = platform.split('-')

	process.env.npm_config_platform = parts[0]
	process.env.npm_config_arch = parts[1]

	await $`node ./install/libvips.js`

	delete process.env.npm_config_platform
	delete process.env.npm_config_arch
}

console.log('Prebuild install')
for (const platform of installPlatforms) {
	const parts = platform.split('-')

	cd(cwd)
	cd(`pkg/sharp/tmp`)

	const opts = {
		target: sharpPackageJson.config.target,
		runtime: sharpPackageJson.config.runtime,
		abi: sharpPackageJson.config.target,
		arch: parts[1],
		platform: parts[0],
		pkg: sharpPackageJson,
		'tag-prefix': 'v',
	}
	const downloadUrl = prebuildUtil.getDownloadUrl(opts)
	await new Promise((resolve, reject) => {
		prebuildInstall.download(downloadUrl, opts, (err) => {
			if (err) reject(err)
			else resolve()
		})
	})

	cd(cwd)
	await fs.move(`pkg/sharp/tmp/build/Release`, `pkg/sharp/prebuilds/${platform}`)

	// Windows needs the dlls to be next to the `.node`, not hidden away
	if (platform.startsWith('win32')) {
		const files = await glob(`pkg/sharp/vendor/*/${platform}*/lib/*`)
		if (files.length === 0) throw new Error(`No vendor files found for ${platform}`)

		for (const file of files) {
			await fs.copyFile(file, `pkg/sharp/prebuilds/${platform}/${path.basename(file)}`)
		}
	}
}

// Cleanup
await fs.rm('pkg/sharp/tmp', { recursive: true })
