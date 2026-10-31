import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { parserOptions: { projectService: true } },
    rules: { '@typescript-eslint/no-explicit-any': 'error' }
  },
  {
    files: ['tests/**/*.ts'],
    languageOptions: { parserOptions: { projectService: false, project: './tests/tsconfig.json' } }
  }
);
