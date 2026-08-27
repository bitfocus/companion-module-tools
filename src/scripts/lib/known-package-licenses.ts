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
	// COPYING in the published tarball is the Boost Software License 1.0 with the notice retention paragraph removed,
	// so it imposes strictly less than BSL-1.0 and recording it as that can only ever overstate its obligations.
	// https://github.com/russellmcc/node-binpack
	'binpack@0.1.0': 'BSL-1.0',
	// LICENSE in the published tarball is BSD-3-Clause, including the clause forbidding use of the copyright holder's
	// name to endorse derived products, https://github.com/fairoakslabs/bufferpack
	'bufferpack@0.0.6': 'BSD-3-Clause',
	// LICENSE, "(The MIT License)", in the published tarball, npm metadata claims MIT but package.json declares
	// nothing, https://github.com/vercel/ms
	'ms@0.7.1': 'MIT',
	// cycle.js in the published tarball carries "Public Domain." in its header comment, and the author has since
	// added "license": "Public-Domain" to https://github.com/dscape/cycle
	'cycle@1.0.3': 'Public-Domain',
	// component.json and bower.json both declare "MIT" in the published tarball, only package.json omits it,
	// https://github.com/component/emitter (1.1.2 republished from https://github.com/sindresorhus/component-emitter)
	'emitter-component@1.1.1': 'MIT',
	'emitter-component@1.1.2': 'MIT',
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
	// Declares "MIT License", which is the name rather than the identifier. LICENSE is "The MIT License (MIT)".
	'xml-escape@1.1.0': 'MIT',
	// Declares "Apache 2.0" through the deprecated licenses array. LICENSE is the Apache License 2.0, followed by an
	// MIT notice covering the QR library vendored into vendor/QRCode, whose text the inventory collects as well.
	'qrcode-terminal@0.12.0': 'Apache-2.0',
}

export function correctedPackageLicense(name: string | undefined, version: string | undefined): string | undefined {
	if (!name || !version) return undefined
	return CORRECTED_PACKAGE_LICENSES[`${name}@${version}`]
}
