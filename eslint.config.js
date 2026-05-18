/**
 * ESLint flat config (ESLint 9 / typescript-eslint 8).
 *
 * Per Claude Code Instruction Pack §1 (ESLint + Prettier required). Formatting
 * rules are delegated to Prettier — `eslint-config-prettier` is applied last to
 * switch off any ESLint rule that would fight the formatter.
 *
 * `vendor/` is excluded: it holds the vendored @kmv/platform-shared build
 * artefact, not first-party source.
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/', 'vendor/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
);
