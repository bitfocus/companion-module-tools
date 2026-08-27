/**
 * Packages which ship no license declaration in their package.json, but whose license has been confirmed by reading
 * what they publish. Only add an entry after checking that version yourself, and record where the license was found.
 *
 * Keys are exact `name@version`, as a later release can change license. A declared license always wins over this list,
 * so an entry can never hide what a package says about itself.
 */
export const KNOWN_PACKAGE_LICENSES: Record<string, string> = {
	// LICENSE.md, "The MIT License", https://github.com/bwindels/exif-parser
	'exif-parser@0.1.12': 'MIT',
	// Readme.md "## License" section in the published tarball, and a LICENSE added to
	// https://github.com/component/indexof after this version was published
	'indexof@0.0.1': 'MIT',
	// Readme.md "## License" section in the published tarball, and a LICENSE added to
	// https://github.com/component/inherit after this version was published
	'component-inherit@0.0.3': 'MIT',
	// Readme.md "## License" section in the published tarball, and a LICENSE added to
	// https://github.com/component/bind after this version was published
	'component-bind@1.0.0': 'MIT',
	// LICENSE, "The MIT License (MIT)", in the published tarball, https://github.com/changchang/seq-queue
	'seq-queue@0.0.5': 'MIT',
	// license, "MIT License", in the published tarball, https://github.com/fabiospampinato/atomically
	'atomically@2.0.3': 'MIT',
	// license, "MIT License", in the published tarball, https://github.com/fabiospampinato/stubborn-fs
	'stubborn-fs@1.2.5': 'MIT',
}

export function knownPackageLicense(name: string | undefined, version: string | undefined): string | undefined {
	if (!name || !version) return undefined
	return KNOWN_PACKAGE_LICENSES[`${name}@${version}`]
}

/**
 * Packages which declare a license that is not a valid SPDX expression, mapped to what the license text they publish
 * actually is. Unlike KNOWN_PACKAGE_LICENSES this overrides what a package says about itself, so it is only consulted
 * when the declaration cannot be parsed, and can never turn a real license into a more convenient one.
 *
 * Only add an entry after reading the license text shipped in that exact version, and record what identified it.
 * Keys are exact `name@version`, so a later release declaring something different is unaffected.
 */
export const CORRECTED_PACKAGE_LICENSES: Record<string, string> = {
	// Declares "BSD". LICENSE is BSD-3-Clause: three conditions, the third forbidding use of the author's name to
	// endorse derived products, which is exactly what separates it from BSD-2-Clause.
	'url-template@2.0.8': 'BSD-3-Clause',
}

export function correctedPackageLicense(name: string | undefined, version: string | undefined): string | undefined {
	if (!name || !version) return undefined
	return CORRECTED_PACKAGE_LICENSES[`${name}@${version}`]
}
