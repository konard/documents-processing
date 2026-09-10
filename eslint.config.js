import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import prettierPlugin from 'eslint-plugin-prettier';
import noChangelogCommentsRule from './eslint-rules/no-changelog-comments.js';

const localPlugin = {
  rules: {
    'no-changelog-comments': noChangelogCommentsRule,
  },
};

export default [
  js.configs.recommended,
  prettierConfig,
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    plugins: {
      local: localPlugin,
      prettier: prettierPlugin,
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        // Node.js globals
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        WebAssembly: 'readonly',
        // Node.js 18+ globals
        fetch: 'readonly',
        URL: 'readonly',
        AbortController: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        globalThis: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        // Runtime-specific globals
        Bun: 'readonly',
        Deno: 'readonly',
      },
    },
    rules: {
      // Prettier integration
      'prettier/prettier': 'error',

      // Code quality rules
      'no-unused-vars': 'error',
      'no-console': 'off', // Allow console in this project
      'no-debugger': 'error',

      // Best practices
      eqeqeq: ['error', 'always'],
      curly: ['error', 'all'],
      'no-var': 'error',
      'prefer-const': 'error',
      'prefer-arrow-callback': 'error',
      'no-duplicate-imports': 'error',

      // ES6+ features
      'arrow-body-style': ['error', 'as-needed'],
      'object-shorthand': ['error', 'always'],
      'prefer-template': 'error',

      // Async/await
      'no-async-promise-executor': 'error',
      'require-await': 'warn',

      // Comments and documentation
      'local/no-changelog-comments': 'warn',
      'spaced-comment': ['error', 'always', { markers: ['/'] }],

      // Complexity rules - reasonable thresholds for maintainability
      complexity: ['warn', 15], // Cyclomatic complexity - allow more complex logic than strict 8
      'max-depth': ['warn', 5], // Maximum nesting depth - slightly more lenient than strict 4
      'max-lines-per-function': [
        'warn',
        {
          max: 150, // More reasonable than strict 50 lines per function
          skipBlankLines: true,
          skipComments: true,
        },
      ],
      'max-params': ['warn', 6], // Maximum function parameters - slightly more lenient than strict 5
      'max-statements': ['warn', 60], // Maximum statements per function - reasonable limit for orchestration functions
      'max-lines': ['error', 1500], // Maximum lines per file - counts all lines including blank lines and comments
    },
  },
  {
    files: ['examples/universal-app/src/**/*.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
      },
    },
  },
  {
    // The callbacks passed to page.evaluate() are serialized and run inside the
    // browser, where the DOM globals apply.
    files: [
      'src/evisa-fill.mjs',
      'src/evisa-required.mjs',
      'src/evisa-session.mjs',
      'src/evisa-download.mjs',
      'src/evisa-slice.mjs',
      'src/evisa-sections.mjs',
      'src/evisa-trace.mjs',
    ],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        Event: 'readonly',
        MouseEvent: 'readonly',
        requestAnimationFrame: 'readonly',
        getComputedStyle: 'readonly',
        location: 'readonly',
      },
    },
  },
  {
    // Test files have different requirements
    files: ['tests/**/*.js', 'tests/**/*.mjs', '**/*.test.js'],
    rules: {
      'require-await': 'off', // Async functions without await are common in tests
      // Dates in test fixtures are sample values, so they are not flagged.
      'local/no-changelog-comments': ['warn', { allowDatesInStrings: true }],
    },
  },
  {
    ignores: [
      'node_modules/**',
      '**/node_modules/**',
      'coverage/**',
      'dist/**',
      '**/dist/**',
      '**/out/**',
      '*.min.js',
      '.eslintcache',
    ],
  },
];
