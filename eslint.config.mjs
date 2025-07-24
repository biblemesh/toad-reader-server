import globals from 'globals';
import pluginJs from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

// This is needed until we upgrade to Node 18.
global.structuredClone = (val) => JSON.parse(JSON.stringify(val))  // eslint-disable-line no-undef

export default tseslint.config([
  {
    files: ['**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: globals.node, // Enable Node.js global variables
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { sourceType: 'module' },
  },
  pluginJs.configs.recommended, // Apply recommended ESLint rules
  tseslint.configs.recommended, // Apply recommended TypeScript rules
  prettierConfig, // Disable rules that conflict with Prettier
]);
