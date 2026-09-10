// @ts-check
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/**
 * Flat config covering every workspace.
 *
 * Deliberately pragmatic rather than maximal: this repository ran with a CI
 * "Lint" step and no linter installed for its whole life, so a strict type-aware
 * ruleset would report several hundred pre-existing findings and simply be
 * disabled again.
 *
 * The original baseline of 144 warnings (107 `any`, 31 unused symbols, 5 hook
 * dependency gaps, 1 undescribed ts-ignore) has since been paid off in full, so
 * those rules are now errors. Leaving them as warnings is what let the baseline
 * accumulate in the first place; a clean tree can afford to hold the line.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "packages/shared/dist/**",
      "**/*.d.ts",
      // Agent worktrees are full repo copies — linting them double-counts
      // every finding and inflates the baseline.
      ".claude/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // Real-defect rules — these stay errors.
      "no-fallthrough": "error",
      "no-unsafe-finally": "error",
      "no-unreachable": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "@typescript-eslint/no-misused-new": "error",
      "@typescript-eslint/no-namespace": "off",

      // Paid down to zero — enforced so it stays there. Genuinely untyped
      // third-party payloads go through the `read*` helpers in
      // @audioshelf/shared rather than an `any` cast.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
          // `const { secret, ...rest } = obj` is how this codebase strips secrets
          // before returning settings to the UI. The omitted binding is the
          // point of the destructure, not an oversight.
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-ignore": "allow-with-description", "ts-expect-error": "allow-with-description" },
      ],
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },

  {
    files: ["apps/backend/**/*.ts", "packages/shared/**/*.ts", "scripts/**/*.{ts,mjs}"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  {
    files: ["apps/frontend/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      // Hook ordering is a correctness rule — never a warning.
      "react-hooks/rules-of-hooks": "error",
      // Clean as of the warning paydown. The fixes that mattered were making
      // `useInvalidate` return a stable callback and memoising `executeSearch`;
      // suppressing the rule tends to hide a stale closure rather than a false
      // positive.
      "react-hooks/exhaustive-deps": "error",
    },
  },

  {
    files: ["**/*.test.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
