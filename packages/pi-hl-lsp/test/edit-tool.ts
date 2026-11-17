import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// The test session disables Pi's built-in file tools, so these stand in for edit and write.
export default function fakeFileTools(pi: ExtensionAPI): void {
  for (const name of ["edit", "write"] as const)
    pi.registerTool({
      name,
      label: name,
      description: `Test ${name} that writes the given text`,
      parameters: Type.Object({ path: Type.String(), text: Type.String() }),
      executionMode: "sequential",
      execute: async (_id, params, _signal, _update, ctx) => {
        if (params.text === "fail") throw new Error("Could not find the text");
        await writeFile(resolve(ctx.cwd, params.path), params.text);
        return {
          content: [{ type: "text", text: `Wrote ${params.path}` }],
          details: undefined,
        };
      },
    });
}
