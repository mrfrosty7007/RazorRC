/* eslint-env node */

/**
 * ESLint runs on the TypeScript sources only. Type-aware linting is
 * deliberately off: `tsc --noEmit` already owns type checking in `npm run
 * build`, and running the type checker twice slows the loop down for no new
 * information.
 */
module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint', 'react-hooks'],
  ignorePatterns: ['dist', 'src-tauri', 'node_modules', '*.cjs'],
  rules: {
    ...require('eslint-plugin-react-hooks').configs.recommended.rules,

    // Unused code is a build error via `noUnusedLocals`; the lint rule exists
    // to catch the argument case, where a leading underscore means "required
    // by the signature, intentionally ignored".
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],

    // The data layer maps SQL rows and Razorpay payloads; a narrow `any` at a
    // boundary is sometimes the honest type, so this warns rather than fails.
    '@typescript-eslint/no-explicit-any': 'warn',

    eqeqeq: ['error', 'always', { null: 'ignore' }],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
  },
};
