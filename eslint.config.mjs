import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["out", "dist", "test-results", "playwright-report", "design"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [tseslint.configs.base],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false, properties: false } }],
      "react-hooks/rules-of-hooks": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name=/^use(Layout)?Effect$/] > ArrowFunctionExpression:matches([expression=true], [async=true])",
          message: "Give effect bodies braces and don't make them async, so they never return a value React treats as cleanup.",
        },
      ],
    },
  },
);
