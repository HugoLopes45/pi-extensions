import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Value } from "typebox/value";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createDapArtifacts } from "../src/artifacts.js";
import { DapError } from "../src/controller.js";
import { DAP_OPERATIONS, DapToolOutputSchemas, type DapOperation } from "../src/schemas.js";
import { createDapTools, type DapToolRuntime } from "../src/tools.js";
import { RecordingDapController } from "./recording-controller.js";
import { createToolContext } from "./tool-context.js";

const tools = createDapTools(() => undefined);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Minimal valid arguments of each tool. */
const MINIMAL_ARGUMENTS = {
  launch: {},
  set_breakpoints: { file_path: "a.ts", breakpoints: [{ line: 1 }] },
  continue: {},
  next: {},
  step_in: {},
  step_out: {},
  pause: {},
  stack: {},
  variables: { frame_id: 0 },
  evaluate: { expression: "x" },
  status: {},
  stop: {},
};

/** Debug Session methods that only observe the Debuggee. */
const OBSERVING_METHODS = new Set(["stack", "variables", "status", "snapshot"]);
/** Debug Session methods that start or resume the Debuggee, so its program runs. */
const RUNNING_METHODS = new Set(["launch", "continue", "next", "stepIn", "stepOut", "evaluate"]);

/** Run one tool against a session that records which Debug Session methods it reaches. */
async function methodsReachedBy(operation: DapOperation): Promise<string[]> {
  const directory = await mkdtemp(join(tmpdir(), "pi-hl-dap-contract-"));
  directories.push(directory);
  const session = new RecordingDapController();
  const runtime: DapToolRuntime = {
    controller: session,
    artifacts: await createDapArtifacts(directory),
  };
  const tool = createDapTools(() => runtime).find(({ name }) => name === `hl_dap_${operation}`);
  if (tool === undefined) throw new Error(`Missing hl_dap_${operation}`);
  await tool.execute(
    "call",
    MINIMAL_ARGUMENTS[operation],
    undefined,
    undefined,
    await createToolContext(directory),
  );
  return session.calls.map(({ name }) => name);
}

function tool(name: string) {
  const found = tools.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`Missing ${name}`);
  return found;
}

describe("DAP tool family", () => {
  test("declares one hl_dap_<operation> tool per operation with its output schema, run sequentially", () => {
    expect(tools.map(({ name }) => name)).toEqual(
      DAP_OPERATIONS.map((operation) => `hl_dap_${operation}`),
    );
    for (const operation of DAP_OPERATIONS) {
      const definition = tool(`hl_dap_${operation}`);
      expect(definition.outputSchema).toBe(DapToolOutputSchemas[operation]);
      expect(definition.executionMode).toBe("sequential");
    }
  });

  test.each(DAP_OPERATIONS)(
    "annotates hl_dap_%s by what it does to the Debuggee",
    async (operation) => {
      const definition = tool(`hl_dap_${operation}`);
      const methods = await methodsReachedBy(operation);
      expect(methods).not.toHaveLength(0);
      const annotations = definition.annotations;
      const runsDebuggee = methods.some((method) => RUNNING_METHODS.has(method));
      const onlyObserves = methods.every((method) => OBSERVING_METHODS.has(method));
      // Breakpoint conditions and evaluation expressions execute Debuggee code even when the tool only forwards them.
      const carriesDebuggeeCode = /"(condition|expression)":/u.test(
        JSON.stringify(definition.parameters),
      );

      expect(annotations?.readOnlyHint === true).toBe(onlyObserves);
      expect(annotations).toMatchObject({
        ...(onlyObserves
          ? {
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            }
          : {}),
        ...(runsDebuggee || carriesDebuggeeCode
          ? { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
          : {}),
        ...(runsDebuggee ? { idempotentHint: false } : {}),
      });
    },
  );

  test("a hl_dap_launch state failure returns isError and an error without desired_breakpoints", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-hl-dap-contract-"));
    directories.push(directory);
    const session = new RecordingDapController();
    vi.spyOn(session, "launch").mockRejectedValueOnce(
      new DapError("state", "launch requires no active Debug Session"),
    );
    const runtime: DapToolRuntime = {
      controller: session,
      artifacts: await createDapArtifacts(directory),
    };
    const launch = createDapTools(() => runtime).find(({ name }) => name === "hl_dap_launch");
    if (launch === undefined) throw new Error("Missing hl_dap_launch");
    const context = await createToolContext(directory);
    const result = await launch.execute("call", {}, undefined, undefined, context);
    expect(session.calls).toEqual([{ name: "snapshot" }]);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      state: "idle",
      error: "HL DAP: DAP Session: launch requires no active Debug Session",
    });
  });

  test.each(tools)(
    "serializes $name parameters without TypeBox modifier markers",
    ({ parameters }) => {
      // Gemini rejects unknown keywords such as `~optional`, which TypeBox modifiers can leave enumerable.
      expect(JSON.stringify(parameters)).not.toMatch(/"~/u);
    },
  );

  test("keeps variables selector exclusivity inside the tool", () => {
    const variables = tool("hl_dap_variables");
    // The provider-facing object admits both selectors; the strict ingress parser does not.
    expect(
      Value.Check(variables.parameters, {
        frame_id: 1,
        variables_reference: 2,
      }),
    ).toBe(true);
    expect(() => variables.prepareArguments?.({ frame_id: 1, variables_reference: 2 })).toThrow(
      "HL DAP: invalid tool arguments",
    );
    expect(() => variables.prepareArguments?.({})).toThrow("HL DAP: invalid tool arguments");
    expect(variables.prepareArguments?.({ frame_id: 0, count: 2 })).toEqual({
      frame_id: 0,
      count: 2,
    });
  });
});
