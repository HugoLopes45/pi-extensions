// Pi supplies its SDK, TUI and TypeBox at runtime; the menu stays a lazily imported chunk.
export default {
  input: "src/index.ts",
  platform: "node",
  external: [/^@earendil-works\//, /^typebox(\/|$)/],
  output: { dir: "dist", format: "esm", cleanDir: true },
};
