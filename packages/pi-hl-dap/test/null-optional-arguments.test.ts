import { startCommandSession } from "pi-hl-utils/testing/command-session";
import { arrayContaining } from "pi-hl-utils/testing/matchers";
import { expectNullOptionalArgumentsOmitted } from "pi-hl-utils/testing/tool-testing";
import { expect, test } from "vitest";

import { createDapExtension } from "../extensions/index.js";

test("every hl_dap_* tool treats null for an optional parameter like omitting it", async () => {
  const harness = await startCommandSession(
    createDapExtension(() => "/nonexistent"),
    "print",
  );
  try {
    const tools = harness.session.extensionRunner
      .getAllRegisteredTools()
      .map(({ definition }) => definition);
    expect(tools).toHaveLength(12);
    const proven = new Map(
      tools.map((tool) => [
        tool.name,
        tool.name === "hl_dap_variables"
          ? expectNullOptionalArgumentsOmitted(tool, { variables_reference: 7 }, [
              "variables_reference",
            ])
          : expectNullOptionalArgumentsOmitted(tool),
      ]),
    );
    expect(proven.get("hl_dap_launch")).toEqual(arrayContaining(["profile", "args", "cwd"]));
    expect(proven.get("hl_dap_stack")).toEqual(arrayContaining(["count", "start"]));
    expect(proven.get("hl_dap_evaluate")).toContain("frame_id");
    expect(proven.get("hl_dap_variables")).toEqual(arrayContaining(["frame_id", "start", "count"]));
  } finally {
    harness.cleanup();
  }
});

test("hl_dap_set_breakpoints drops a null condition of a breakpoint", async () => {
  const harness = await startCommandSession(
    createDapExtension(() => "/nonexistent"),
    "print",
  );
  try {
    const tool = harness.session.extensionRunner.getToolDefinition("hl_dap_set_breakpoints");
    expect(tool).toBeDefined();
    const withNull = {
      file_path: "a.ts",
      breakpoints: [{ line: 3, condition: null }, { line: 4 }],
    };
    expect(tool?.prepareArguments?.(withNull)).toEqual({
      file_path: "a.ts",
      breakpoints: [{ line: 3 }, { line: 4 }],
    });
  } finally {
    harness.cleanup();
  }
});
