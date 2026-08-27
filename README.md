# @companion-module/tools

This is a collection of tools used for developing and verifying Companion modules.

## Scripts

### companion-module-build

When used, this will build a module ready for distribution.

More information on this command is available [on the wiki](https://github.com/bitfocus/companion-module-base/wiki/Module-packaging).

### companion-generate-manifest

Generate the new format manifest from an old `package.json`.

## Licensing

A module has two licenses, and they are not the same thing:

- `license` in `package.json` is the license of the code you wrote. This must be `MIT`, so module source always stays
  portable and can be reused anywhere.
- `license` in `companion/manifest.json` is the license the packaged module is distributed under. A build bundles your
  code together with its dependencies, so this has to be a license that whole blob can be shipped under.

Your own code stays MIT even when a dependency is copyleft. If you bundle a GPL-3.0 dependency, your source stays MIT
while the manifest declares `GPL-3.0-only`, because that is what the combined package must be distributed as. Anyone
reusing your source on its own still gets it under MIT.

The build and check commands validate your production dependencies against the manifest license. Supported values are
`MIT` (recommended, it can use the most of npm), `GPL-2.0-only` and `GPL-3.0-only`. Dual licensing is not supported,
and a module which declares no license in its manifest falls back to the one in `package.json`.

Everything reachable through `dependencies` is checked, whether or not webpack ends up bundling it. `devDependencies`
are never checked. A build also writes an aggregated `LICENSE` (and a `NOTICE`, where dependencies ship one) into the
package, collected from the license files of everything it ships.

Some older packages ship a license file but declare no license in their `package.json`, so there is nothing to check
against. Those are listed in `scripts/lib/known-package-licenses.js` once their license has been confirmed from what
they publish, so open a PR there if you hit one. A license a package declares itself always wins over that list.

Pass `--ignore-license-rules` to report license problems as warnings instead of failing the command.

## Upgrading from v1.x to v2.0

v2.0 of this library includes some breaking changes to how eslint and prettier handled. Instead of it being installed as a dependency and being directly usable by modules, it has to be explicitly installed by modules.

This change was done for two reasons:

1. Very few modules use eslint, making this extra weight for them for no gain.
2. Recent versions of yarn do not expose these binaries in a way which is easily callable by modules, requiring tricks to be able to execute them.

To resolve this, you will need to do a `yarn add --dev eslint prettier` in your modules to install the dependencies, and update any scripts to remove the invocation hacks.

This also allows for eslint to be updated to v9, which requires a new config format. This unfortunately means that your config file needs to be replaced.

A new basic config should be called `eslint.config.mjs` (remove any existing `.eslintrc.json` or `.eslintrc.cjs`) and could contain:

```js
import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

export default generateEslintConfig({})
```

If using TypeScript, you should specify a `typescriptRoot`:

```js
import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

export default generateEslintConfig({
	enableTypescript: true,
})
```

You can easily override rules in this setup with:

```js
import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

const baseConfig = await generateEslintConfig({
	enableTypescript: true,
})

const customConfig = [
	...baseConfig,

	{
		rules: {
			'n/no-missing-import': 'off',
			'node/no-unpublished-import': 'off',
		},
	},
]

export default customConfig
```

More options are available for the `generateEslintConfig` function, check the wiki or the method signature to see what is available.
