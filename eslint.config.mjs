import globals from 'globals';
import pluginJs from '@eslint/js';
import prettier from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

export default [
  {
    files: ['**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: globals.node, // Enable Node.js global variables
    },
  },
  pluginJs.configs.recommended, // Apply recommended ESLint rules
  prettierConfig, // Disable rules that conflict with Prettier
  {
    plugins: { prettier },
    rules: {
      'prettier/prettier': 'error', // Treat Prettier formatting issues as ESLint errors
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }], // Warn about unused variables, except those prefixed with "_"
    },
  },
];
