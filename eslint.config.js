const globals = require("globals");
const tseslint = require("typescript-eslint");

module.exports = [
  {
    // Global ignores for compiled output, node modules, and all JS files.
    ignores: ["dist/", "node_modules/", "**/*.js"],
  },
  // Base TypeScript configuration
  ...tseslint.configs.recommended,
  {
    // Custom rules for TypeScript files
    files: ["**/*.ts"],
    rules: {
      "prefer-const": "off", // Disabled due to false positives in orchestrator.ts after refactoring
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "warn",
    },
  },
];
