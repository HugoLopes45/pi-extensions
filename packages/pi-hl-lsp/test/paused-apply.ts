// Child process for rename.test.ts: applies an edit with a move, then hangs instead of removing its journal,
// so the parent can kill it at the point where every file is written and moved but the journal remains.
import fs from "node:fs/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";

// Workspace sources import siblings as .js; under Node's type stripping only the .ts file exists.
registerHooks({
  resolve: (specifier, context, nextResolve) =>
    nextResolve(
      specifier.startsWith(".") && !context.parentURL?.includes("/node_modules/")
        ? specifier.replace(/\.js$/u, ".ts")
        : specifier,
      context,
    ),
});

// The default export is the mutable module object; syncBuiltinESMExports copies the change to named imports.
const { unlink } = fs;
Object.assign(fs, {
  unlink: async (path: string) => {
    if (!path.endsWith(".json")) return unlink(path);
    process.stdout.write("paused\n");
    await new Promise(() => setInterval(() => {}, 1000));
  },
});
syncBuiltinESMExports();

const [root, response, from, to] = process.argv.slice(2);
if (root === undefined || response === undefined || from === undefined || to === undefined)
  throw new Error("usage: paused-apply.ts <root> <response> <from> <to>");
const { applyWorkspaceEdit } = await import("../src/rename.ts");
await applyWorkspaceEdit(JSON.parse(response), root, undefined, { from, to });
