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
}

export function knownPackageLicense(name: string | undefined, version: string | undefined): string | undefined {
	if (!name || !version) return undefined
	return KNOWN_PACKAGE_LICENSES[`${name}@${version}`]
}
