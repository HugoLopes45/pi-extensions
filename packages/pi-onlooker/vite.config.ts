import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "vitest", "node", "promise"],
    options: { typeAware: true, typeCheck: true },
    categories: { correctness: "error", suspicious: "error", perf: "error" },
    rules: {
      complexity: ["error", { max: 20 }],
      "typescript/no-unsafe-argument": "error",
      "typescript/no-unsafe-assignment": "error",
      "typescript/no-unsafe-call": "error",
      "typescript/no-unsafe-member-access": "error",
      "typescript/no-unsafe-return": "error",
      "typescript/no-deprecated": "error",
      "typescript/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],
      // Reviews, deliveries and session turns run in order by design.
      "eslint/no-await-in-loop": "off",
      // Helpers stay next to their only caller.
      "unicorn/consistent-function-scoping": "off",
      // `return;` ends functions typed `T | undefined`; the declared types already check each path.
      "typescript/consistent-return": "off",
      // Pi's native fields, such as `_pendingCustomMessages`, start with an underscore.
      "eslint/no-underscore-dangle": "off",
      // Copies keep projected values immutable; the arrays are small.
      "oxc/no-map-spread": "off",
    },
    overrides: [
      {
        files: ["test/**"],
        rules: {
          // Tests read raw JSON payloads and build partial SDK objects.
          "typescript/no-unsafe-argument": "off",
          "typescript/no-unsafe-assignment": "off",
          "typescript/no-unsafe-call": "off",
          "typescript/no-unsafe-member-access": "off",
          "typescript/no-unsafe-return": "off",
          "typescript/no-unsafe-type-assertion": "off",
          // Fixtures register their extensions and providers on import.
          "import/no-unassigned-import": "off",
          // Fake providers settle streams from promise callbacks.
          "promise/always-return": "off",
          "promise/no-callback-in-promise": "off",
        },
      },
      {
        files: ["src/utils/layered-settings.ts"],
        rules: {
          // TypeScript cannot correlate an option key's authored and resolved types
          // (microsoft/TypeScript#30581); each assertion states the invariant that holds it.
          "typescript/no-unsafe-type-assertion": "off",
          "typescript/no-unnecessary-type-parameters": "off",
        },
      },
      {
        files: ["src/utils/pi-agent-session-discovery.ts"],
        rules: {
          // Wraps the prototype method and re-invokes it with each receiver through `.call(this)`.
          "typescript/unbound-method": "off",
        },
      },
    ],
  },
});
