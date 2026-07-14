import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'build/**',
      '.vite/**',
      '*.min.js',
      'public/**',
      'src/world/SceneOld.js',
      // Generated (scripts/vendor-stretch-engine.mjs): the engine source as a string.
      'src/audio/playback/vendor/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        bootstrap: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-debugger': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      'prefer-const': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-binary-expression': 'warn',
      'no-prototype-builtins': 'warn',
      'no-useless-assignment': 'warn',
      'no-useless-catch': 'warn',
      'preserve-caught-error': 'warn',
    },
  },
];
