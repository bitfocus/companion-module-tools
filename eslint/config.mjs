// @ts-check

import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended'
import eslint from '@eslint/js'
import neslint from 'eslint-plugin-n'

/**
 *
 * @template T
 * @param {Record<string, T | null | undefined>} obj
 * @returns {Record<string, T>}
 */
function compactObj(obj) {
	/** @type {Record<string, T>} */
	const result = {}

	for (const [key, value] of Object.entries(obj)) {
		if (value) result[key] = value
	}

	return result
}

/***
 * @param {{ enableJest?: boolean, enableTypescript?: boolean, ignores?: string[] }} [options={}] - Options to customize the config
 * @returns {Promise<import('eslint').Linter.Config[]>}
 */
export async function generateEslintConfig(options = {}) {
	const tseslint = options.enableTypescript ? await import('typescript-eslint') : null

	/** @type {import('eslint').Linter.Config} */
	const result = {
		// extends: commonExtends,
		plugins: compactObj({
			'@typescript-eslint': tseslint ? tseslint.plugin : null,
		}),
		rules: {
			// Default rules to be applied everywhere
			'prettier/prettier': 'error',

			...eslint.configs.recommended.rules,

			'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_(.+)' }],
			'no-extra-semi': 'off',
			// 'n/no-unsupported-features/es-syntax': ['error', { ignores: ['modules'] }],
			'no-use-before-define': 'off',
			'no-warning-comments': ['error', { terms: ['nocommit', '@nocommit', '@no-commit'] }],
			// 'jest/no-mocks-import': 'off',
		},
	}

	return [
		// setup the parser first
		tseslint
			? {
					languageOptions: {
						parser: tseslint.parser,
						parserOptions: {
							project: true,
						},
					},
				}
			: null,

		neslint.configs['flat/recommended-script'],
		result,
		...(tseslint ? tseslint.configs.recommendedTypeChecked : []),
		{
			// disable type-aware linting on JS files
			files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
			...(tseslint ? tseslint.configs.disableTypeChecked : {}),
		},
		{
			files: ['*.mjs'],
			languageOptions: {
				sourceType: 'module',
			},
		},
		tseslint
			? {
					files: ['**/*.ts', '**/*.cts', '**/*.mts'],
					rules: {
						'@typescript-eslint/no-explicit-any': 'off',
						'@typescript-eslint/interface-name-prefix': 'off',
						'@typescript-eslint/no-unused-vars': [
							'error',
							{ argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', varsIgnorePattern: '^_(.+)' },
						],
						'@typescript-eslint/no-floating-promises': 'error',
						'@typescript-eslint/explicit-module-boundary-types': ['error'],
						'@typescript-eslint/promise-function-async': 'error',
						'@typescript-eslint/require-await': 'off', // conflicts with 'promise-function-async'

						/** Disable some annoyingly strict rules from the 'recommended-requiring-type-checking' pack */
						'@typescript-eslint/no-unsafe-assignment': 0,
						'@typescript-eslint/no-unsafe-member-access': 0,
						'@typescript-eslint/no-unsafe-argument': 0,
						'@typescript-eslint/no-unsafe-return': 0,
						'@typescript-eslint/no-unsafe-call': 0,
						'@typescript-eslint/restrict-template-expressions': 0,
						'@typescript-eslint/restrict-plus-operands': 0,
						'@typescript-eslint/no-redundant-type-constituents': 0,
						/** End 'recommended-requiring-type-checking' overrides */
					},
				}
			: null,
		tseslint
			? {
					files: ['**/__tests__/**/*', 'test/**/*'],
					rules: {
						'@typescript-eslint/ban-ts-ignore': 'off',
						'@typescript-eslint/ban-ts-comment': 'off',
					},
				}
			: null,
		{
			// disable type-aware linting on JS files
			files: [
				'examples/**/*.js',
				'examples/**/*.cjs',
				'examples/**/*.mjs',
				'examples/**/*.ts',
				'examples/**/*.cts',
				'examples/**/*.mts',
			],
			rules: {
				'no-process-exit': 'off',
				'n/no-missing-import': 'off',
			},
		},

		// Add prettier at the end to give it final say on formatting
		eslintPluginPrettierRecommended,
		{
			// But lastly, ensure that we ignore certain paths
			ignores: ['**/dist/*', '/dist', '**/pkg/*', '**/docs/*', '**/generated/*', ...(options.ignores || [])],
		},
		{
			files: ['eslint.config.*'],
			rules: {
				'n/no-unpublished-import': 'off',
			},
		},
	].filter((v) => !!v)
}
