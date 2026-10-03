import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      // `catch (_err)` explicitly communicates that a failure is handled but
      // the thrown value is intentionally not inspected. Other unused locals
      // and unprefixed caught errors remain visible as warnings.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
]);

export default eslintConfig;
