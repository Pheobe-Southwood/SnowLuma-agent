import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "data/**", "test/fixtures/**"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tsParser },
    rules: {
      "no-console": "off",
      "no-constant-condition": "off",
      "no-unused-vars": "off",
    },
  },
];
