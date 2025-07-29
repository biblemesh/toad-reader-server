import globals from 'globals';
import pluginJs from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

// This is needed until we upgrade to Node 18.
global.structuredClone = (val) => JSON.parse(JSON.stringify(val))  // eslint-disable-line no-undef

export default tseslint.config([
  pluginJs.configs.recommended, // Apply recommended ESLint rules
  tseslint.configs.recommended, // Apply recommended TypeScript rules
  prettierConfig, // Disable rules that conflict with Prettier
  {
    files: ['**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: globals.node, // Enable Node.js global variables
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-redeclare': 'off',
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { sourceType: 'module' },
  },
]);
