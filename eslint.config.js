import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

/**
 * Lint rules.
 *
 * Kept deliberately small. The rules here are the ones that catch real
 * mistakes in this codebase — a forgotten await inside a workflow, a promise
 * nobody handles — rather than a broad style ruleset, which typecheck and
 * review already cover.
 */

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'discovery/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
        project: './tsconfig.json',
      },
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        crypto: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        NodeJS: 'readonly',
        document: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        Element: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,

      // A dropped await inside a browser workflow means clicking before the
      // page is ready, which is the single most common source of flakiness.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',

      // console is for the setup scripts only; everything else uses pino,
      // which runs output through the redaction layer.
      'no-console': 'error',

      eqeqeq: ['error', 'smart'],
      'no-undef': 'off',
    },
  },
  {
    files: ['tests/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
];
