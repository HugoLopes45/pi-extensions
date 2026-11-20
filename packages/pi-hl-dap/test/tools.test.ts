import filesystem, { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { isRecord } from "pi-hl-utils/record";
import { hasSteering, queueSteering, clearSteering } from "pi-hl-utils/steering";
import {
  anyInstance,
  arrayContaining,
  objectContaining,
  stringContaining,
} from "pi-hl-utils/testing/matchers";
import { Value } from "typebox/value";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DapConnectionError } from "../src/adapter.js";
import { createDapArtifacts } from "../src/artifacts.js";
import type { DapResult } from "../src/controller.js";
import { DapError } from "../src/controller.js";
import {
  DAP_OPERATIONS,
  DapToolResultDetailsSchema,
  type DapOperation,
  type DapToolCallArguments,
  type DapToolRenderDetails,
} from "../src/schemas.js";
import { createDapTools, type DapToolRuntime } from "../src/tools.js";
import { TROUBLESHOOTING_HINT } from "../src/troubleshooting.js";
import { expectDapToolOutput } from "./output.js";
import { RecordingDapController, type RecordedDapInput } from "./recording-controller.js";
import { createToolContext } from "./tool-context.js";

const temporaryDirectories: string[] = [];
const sessionIds: string[] = [];

/** Arguments of any one DAP tool, as a model or hook may supply them. */
type DapToolInput = Omit<DapToolCallArguments, "operation">;

/** The execution surface every `hl_dap_<operation>` tool shares. */
interface ExecutableDapTool {
  readonly name: string;
  readonly prepareArguments?: (input: unknown) => DapToolInput;
  execute(
    toolCallId: string,
    input: DapToolInput,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<DapToolRenderDetails | undefined> | undefined,
    context: ExtensionToolContext,
  ): Promise<AgentToolResult<DapToolRenderDetails | undefined>>;
}

function dapTool(
  getRuntime: () => DapToolRuntime | undefined,
  operation: DapOperation,
): ExecutableDapTool {
  const tool: ExecutableDapTool | undefined = createDapTools(getRuntime).find(
    ({ name }) => name === `hl_dap_${operation}`,
  );
  if (tool === undefined) throw new Error(`Missing hl_dap_${operation}`);
  // Every executed result, including state failures and cancelled waits, must satisfy the
  // tool's declared outputSchema, because codemode hands scripts exactly that value.
  return {
    ...tool,
    async execute(toolCallId, input, signal, onUpdate, context) {
      const result = await tool.execute(toolCallId, input, signal, onUpdate, context);
      expectDapToolOutput(operation, result);
      return result;
    },
  };
}

async function createToolFixture(): Promise<{
  readonly context: ExtensionToolContext;
  readonly cwd: string;
  readonly runtime: DapToolRuntime;
  readonly session: RecordingDapController;
}> {
  const cwd = await mkdtemp(resolve(tmpdir(), "pi-hl-dap-tool-"));
  temporaryDirectories.push(cwd);
  const session = new RecordingDapController();
  const artifacts = await createDapArtifacts(cwd);
  const context = await createToolContext(cwd);
  sessionIds.push(context.sessionManager.getSessionId());
  return { context, cwd, runtime: { controller: session, artifacts }, session };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const id of sessionIds.splice(0)) clearSteering(id);
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("DAP tools", () => {
  test("return complete script-facing results beside bounded Observer UI details", async () => {
    const fixture = await createToolFixture();
    const longValue = "x".repeat(1_000);
    const output = "line\n".repeat(20_000);
    fixture.session.result = {
      snapshot: {
        state: "stopped",
        adapterId: "node",
        profileId: "node",
        stopReason: "breakpoint",
        threadId: 3,
      },
      output,
      discardedOutputBytes: 4,
      desiredBreakpoints: [
        {
          filePath: "/workspace/app.ts",
          breakpoints: [{ line: 2, condition: "ready" }],
        },
      ],
      variableGroups: [
        {
          scope: { name: "Locals", variablesReference: 5, expensive: false },
          variables: Array.from({ length: 25 }, (_, index) => ({
            name: `value-${index}`,
            value: longValue,
            type: "string",
            evaluateName: `value${index}`,
            variablesReference: 0,
          })),
        },
      ],
    };
    const result = await dapTool(() => fixture.runtime, "variables").execute(
      "variables",
      { frame_id: 1 },
      undefined,
      undefined,
      fixture.context,
    );
    expect(result.structuredContent).toEqual({
      state: "stopped",
      adapter_id: "node",
      profile_id: "node",
      stop_reason: "breakpoint",
      thread_id: 3,
      output,
      output_discarded_bytes: 4,
      scopes: [
        {
          name: "Locals",
          variables_reference: 5,
          expensive: false,
          variables: Array.from({ length: 25 }, (_, index) => ({
            name: `value-${index}`,
            value: longValue,
            type: "string",
            evaluate_name: `value${index}`,
            variables_reference: 0,
          })),
        },
      ],
    });
    // The model-facing text is truncated and the Observer UI rows are bounded; scripts lose nothing.
    expect(result.content[0]).toMatchObject({
      text: stringContaining("Result Spill"),
    });
    expect(result.content[0]).toMatchObject({
      text: stringContaining("Debuggee output (4 older bytes discarded):\nline\n"),
    });
    expect(result.details).toMatchObject({
      output_truncated: true,
      presentation: {
        omitted_count: 6,
        rows: arrayContaining([objectContaining({ value: `${"x".repeat(499)}…` })]),
      },
    });
  });

  test("project every operation-specific result into its typed output", async () => {
    const fixture = await createToolFixture();
    await writeFile(resolve(fixture.cwd, "app.ts"), "");
    const base = {
      snapshot: {
        state: "stopped",
        adapterId: "a",
        profileId: "p",
        stopReason: "step",
      },
      output: "",
      discardedOutputBytes: 0,
      desiredBreakpoints: [],
    } satisfies DapResult;
    const cases: readonly [DapOperation, DapToolInput, DapResult, object][] = [
      [
        "set_breakpoints",
        { file_path: "app.ts", breakpoints: [{ line: 4 }] },
        {
          ...base,
          breakpoints: [
            {
              id: 1,
              verified: true,
              line: 4,
              column: 2,
              source: { name: "app.ts", path: "/w/app.ts" },
            },
            { verified: false, message: "not loaded" },
          ],
        },
        {
          desired_breakpoints: [],
          breakpoints: [
            {
              id: 1,
              verified: true,
              line: 4,
              column: 2,
              source_name: "app.ts",
              source_path: "/w/app.ts",
            },
            { verified: false, message: "not loaded" },
          ],
        },
      ],
      [
        "stack",
        {},
        {
          ...base,
          stackFrames: [
            {
              id: 7,
              name: "main",
              line: 3,
              column: 1,
              source: { path: "/w/app.ts" },
            },
          ],
          totalFrames: 9,
        },
        {
          stack_frames: [
            {
              id: 7,
              name: "main",
              line: 3,
              column: 1,
              source_path: "/w/app.ts",
            },
          ],
          total_frames: 9,
        },
      ],
      [
        "variables",
        { variables_reference: 4 },
        {
          ...base,
          variables: [{ name: "a", value: "1", variablesReference: 0 }],
        },
        { variables: [{ name: "a", value: "1", variables_reference: 0 }] },
      ],
      [
        "evaluate",
        { expression: "a + 1" },
        {
          ...base,
          evaluation: { result: "2", type: "number", variablesReference: 0 },
        },
        { evaluation: { result: "2", type: "number", variables_reference: 0 } },
      ],
    ];
    for (const [operation, input, sessionResult, expected] of cases) {
      fixture.session.result = sessionResult;
      const result = await dapTool(() => fixture.runtime, operation).execute(
        operation,
        input,
        undefined,
        undefined,
        fixture.context,
      );
      expect(result.structuredContent).toEqual({
        state: "stopped",
        adapter_id: "a",
        profile_id: "p",
        stop_reason: "step",
        output: "",
        output_discarded_bytes: 0,
        ...expected,
      });
    }
  });

  test("structured results carry desired_breakpoints only for set_breakpoints, launch, and status", async () => {
    const fixture = await createToolFixture();
    fixture.session.result = {
      snapshot: {
        state: "stopped",
        adapterId: "a",
        profileId: "p",
        stopReason: "step",
      },
      output: "",
      discardedOutputBytes: 0,
      desiredBreakpoints: [
        {
          filePath: "/w/app.ts",
          breakpoints: [{ line: 2, condition: "ready" }],
        },
      ],
      stackFrames: [],
      variables: [],
    };
    const inputs = {
      launch: {},
      set_breakpoints: {
        file_path: "/w/app.ts",
        breakpoints: [{ line: 2, condition: "ready" }],
      },
      continue: {},
      next: {},
      step_in: {},
      step_out: {},
      pause: {},
      stack: {},
      variables: { variables_reference: 1 },
      evaluate: { expression: "x" },
      status: {},
      stop: {},
    } satisfies Record<DapOperation, DapToolInput>;
    const carriers: DapOperation[] = [];
    for (const operation of DAP_OPERATIONS) {
      const result = await dapTool(() => fixture.runtime, operation).execute(
        operation,
        inputs[operation],
        undefined,
        undefined,
        fixture.context,
      );
      const output = result.structuredContent;
      if (!isRecord(output)) throw new Error("Expected structured DAP result");
      if (Object.keys(output).includes("desired_breakpoints")) {
        carriers.push(operation);
      }
      expect(output.desired_breakpoints).toEqual(
        ["launch", "set_breakpoints", "status"].includes(operation)
          ? [
              {
                file_path: "/w/app.ts",
                breakpoints: [{ line: 2, condition: "ready" }],
              },
            ]
          : undefined,
      );
    }
    expect(carriers).toEqual(["launch", "set_breakpoints", "status"]);
  });

  describe("compact text results", () => {
    const stoppedSnapshot = {
      state: "stopped",
      adapterId: "node",
      profileId: "node",
      stopReason: "breakpoint",
      threadId: 1,
    } as const;

    async function textOf(
      operation: DapOperation,
      input: DapToolInput,
      result: Partial<DapResult>,
    ): Promise<string> {
      const fixture = await createToolFixture();
      fixture.session.result = {
        snapshot: { state: "idle" },
        output: "",
        discardedOutputBytes: 0,
        desiredBreakpoints: [],
        ...result,
      };
      const executed = await dapTool(() => fixture.runtime, operation).execute(
        operation,
        input,
        undefined,
        undefined,
        fixture.context,
      );
      return executed.content.map((item) => (item.type === "text" ? item.text : "")).join("");
    }

    test("keeps a stop reason, Breakpoint condition and path on one line each", async () => {
      const text = await textOf(
        "status",
        {},
        {
          snapshot: {
            ...stoppedSnapshot,
            stopReason: "step\nDebuggee output:",
          },
          desiredBreakpoints: [
            {
              filePath: "/w/a\nb.ts",
              breakpoints: [{ line: 2, condition: "x\nDebuggee output:" }],
            },
          ],
        },
      );
      expect(text).not.toMatch(/^Debuggee output:/mu);
      expect(text).toContain("stopped (step\\nDebuggee output:)");
      expect(text).toContain("a\\nb.ts:2 if x\\nDebuggee output:");
    });

    test("reports the adapter's negative Breakpoint ids unchanged", async () => {
      const filePath = import.meta.filename;
      await expect(
        textOf(
          "set_breakpoints",
          { file_path: filePath, breakpoints: [{ line: 2 }] },
          { breakpoints: [{ id: -3, verified: true, line: 2 }] },
        ),
      ).resolves.toContain("line 2 (id -3) verified");
      await expect(
        textOf(
          "continue",
          {},
          {
            snapshot: stoppedSnapshot,
            stop: { description: "hit", hitBreakpointIds: [-3] },
          },
        ),
      ).resolves.toContain("hit breakpoint ids: -3");
    });

    test("a stop names the top frame's file, line, function, and id, why it stopped, and the Breakpoints hit", async () => {
      const fixture = await createToolFixture();
      fixture.session.result = {
        snapshot: stoppedSnapshot,
        output: "hello\n",
        discardedOutputBytes: 0,
        desiredBreakpoints: [{ filePath: `${fixture.cwd}/app.js`, breakpoints: [{ line: 3 }] }],
        stop: {
          description: "Paused on breakpoint",
          hitBreakpointIds: [4],
          topFrame: {
            id: 12,
            name: "add",
            line: 3,
            column: 5,
            source: { name: "app.js", path: `${fixture.cwd}/app.js` },
          },
        },
      };

      const result = await dapTool(() => fixture.runtime, "continue").execute(
        "continue",
        {},
        undefined,
        undefined,
        fixture.context,
      );

      expect(result.content).toEqual([
        {
          type: "text",
          text: "stopped (breakpoint) at app.js:3:5 in add (frame 12) · thread 1\ndescription: Paused on breakpoint\nhit breakpoint ids: 4\n\nDebuggee output:\nhello\n",
        },
      ]);
      expect(result.structuredContent).toMatchObject({
        state: "stopped",
        stop_reason: "breakpoint",
        thread_id: 1,
        stop_description: "Paused on breakpoint",
        hit_breakpoint_ids: [4],
        top_frame: {
          id: 12,
          name: "add",
          line: 3,
          column: 5,
          source_name: "app.js",
          source_path: `${fixture.cwd}/app.js`,
        },
      });
      expect(result.structuredContent).not.toHaveProperty("desired_breakpoints");
    });

    test("a stop in a Child session names it in text and structuredContent", async () => {
      const fixture = await createToolFixture();
      fixture.session.result = {
        snapshot: stoppedSnapshot,
        output: "",
        discardedOutputBytes: 0,
        desiredBreakpoints: [],
        stop: { childSession: "worker.js [42]" },
      };

      const result = await dapTool(() => fixture.runtime, "continue").execute(
        "continue",
        {},
        undefined,
        undefined,
        fixture.context,
      );

      expect(result.content).toEqual([
        {
          type: "text",
          text: "stopped (breakpoint) · thread 1\nchild session: worker.js [42]",
        },
      ]);
      expectDapToolOutput("continue", result);
      expect(result.structuredContent).toMatchObject({
        child_session: "worker.js [42]",
      });
      await expect(textOf("next", {}, { snapshot: stoppedSnapshot })).resolves.not.toContain(
        "child session",
      );
    });

    test("an unexpanded expensive scope is listed with its reference to expand", async () => {
      const fixture = await createToolFixture();
      fixture.session.result = {
        snapshot: stoppedSnapshot,
        output: "",
        discardedOutputBytes: 0,
        desiredBreakpoints: [],
        variableGroups: [
          {
            scope: { name: "Local", variablesReference: 5, expensive: false },
            variables: [{ name: "a", value: "1", variablesReference: 0 }],
          },
          { scope: { name: "Global", variablesReference: 6, expensive: true } },
        ],
      };

      const result = await dapTool(() => fixture.runtime, "variables").execute(
        "variables",
        { frame_id: 1 },
        undefined,
        undefined,
        fixture.context,
      );

      expect(result.content).toEqual([
        {
          type: "text",
          text: [
            "Scope Local [variables_reference 5]: 1 variable",
            "  a = 1",
            "Scope Global [variables_reference 6] (expensive, not expanded; pass its variables_reference to expand)",
          ].join("\n"),
        },
      ]);
      expect(result.structuredContent).toMatchObject({
        scopes: [
          { name: "Local", variables: [{ name: "a", value: "1" }] },
          { name: "Global", variables_reference: 6, expensive: true },
        ],
      });
      expect(result.structuredContent).not.toHaveProperty("scopes.1.variables");
    });

    test("text over the limit is cut at line boundaries and is never empty", async () => {
      const fixture = await createToolFixture();
      const tool = dapTool(() => fixture.runtime, "status");
      const running = {
        state: "running",
        adapterId: "node",
        profileId: "node",
      } as const;

      // 5,000 lines of 20 bytes: the visible part is the first whole lines up to Pi's line limit.
      const manyLines = "0123456789abcdefghi\n".repeat(5_000);
      fixture.session.result = {
        snapshot: running,
        output: manyLines,
        discardedOutputBytes: 0,
        desiredBreakpoints: [],
      };
      const cutByLines = await tool.execute("lines", {}, undefined, undefined, fixture.context);
      const linesText = cutByLines.content[0]?.type === "text" ? cutByLines.content[0].text : "";
      const visibleLines = linesText.split("\n\n[HL DAP: output truncated")[0] ?? "";
      expect(visibleLines.startsWith("running\n\nDebuggee output:\n0123456789abcdefghi")).toBe(
        true,
      );
      expect(
        visibleLines
          .split("\n")
          .every(
            (line) => line === "" || /^(running|Debuggee output:|0123456789abcdefghi)$/u.test(line),
          ),
      ).toBe(true);

      // One 200 KB evaluation result without a newline: the first line alone exceeds the byte limit.
      fixture.session.result = {
        snapshot: stoppedSnapshot,
        output: "",
        discardedOutputBytes: 0,
        desiredBreakpoints: [],
        evaluation: { result: "é".repeat(100_000), variablesReference: 0 },
      };
      const hugeLine = await dapTool(() => fixture.runtime, "evaluate").execute(
        "huge",
        { expression: "x" },
        undefined,
        undefined,
        fixture.context,
      );
      const hugeText = hugeLine.content[0]?.type === "text" ? hugeLine.content[0].text : "";
      expect(hugeText).toContain("Result Spill");
      expect(hugeText.length).toBeGreaterThan(20_000);
      expect(hugeText.startsWith("éééé")).toBe(true);
      expect(hugeText).not.toContain("\uFFFD");
      // The note names a complete Result Spill and still fits inside Pi's text budget.
      if (hugeLine.details === undefined || "kind" in hugeLine.details) {
        throw new Error("Expected final DAP result details");
      }
      const spillPath = hugeLine.details.spill_path;
      if (spillPath === undefined) throw new Error("Expected Result Spill path");
      expect(hugeText).toContain(`complete Result Spill: ${spillPath}`);
      expect(Buffer.byteLength(hugeText, "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
      expect(hugeText.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
      expect(await readFile(spillPath, "utf8")).toContain("é".repeat(100_000));
    });

    test("adapter strings stay on one line and cannot fake the Debuggee output heading", async () => {
      const text = await textOf(
        "evaluate",
        { expression: "x" },
        {
          snapshot: stoppedSnapshot,
          evaluation: {
            result: "a\n\nDebuggee output:\nb",
            variablesReference: 0,
          },
        },
      );
      expect(text).toBe("a\\n\\nDebuggee output:\\nb");
    });

    test("a termination reports its exit code and reason", async () => {
      await expect(
        textOf(
          "continue",
          {},
          {
            snapshot: {
              state: "terminated",
              adapterId: "node",
              profileId: "node",
              exitCode: 0,
              terminationReason: "exited",
            },
          },
        ),
      ).resolves.toBe("terminated (exit code 0; exited)");
    });

    test("only hl_dap_set_breakpoints, hl_dap_launch, and hl_dap_status show Desired Breakpoints", async () => {
      const existingFile = import.meta.filename;
      const desiredBreakpoints = [
        {
          filePath: existingFile,
          breakpoints: [{ line: 2 }, { line: 9, condition: "ready" }],
        },
      ];
      const set = await textOf(
        "set_breakpoints",
        { file_path: existingFile, breakpoints: [{ line: 2 }] },
        {
          desiredBreakpoints,
          breakpoints: [
            { id: 1, verified: true, line: 2 },
            { id: 2, verified: false, line: 9, message: "no such line" },
          ],
        },
      );
      expect(set).toBe(
        [
          "Breakpoints: 1 of 2 verified",
          "  line 2 (id 1) verified",
          "  line 9 (id 2) not verified: no such line",
          "Desired Breakpoints:",
          `  ${existingFile}:2`,
          `  ${existingFile}:9 if ready`,
        ].join("\n"),
      );
      const listed = [
        "Desired Breakpoints:",
        `  ${existingFile}:2`,
        `  ${existingFile}:9 if ready`,
      ];
      await expect(textOf("status", {}, { desiredBreakpoints })).resolves.toBe(
        ["idle (no Debug Session)", ...listed].join("\n"),
      );
      await expect(
        textOf("launch", {}, { desiredBreakpoints, snapshot: stoppedSnapshot }),
      ).resolves.toBe(["stopped (breakpoint) · thread 1", ...listed].join("\n"));
      // An empty list adds nothing to a state report.
      await expect(textOf("status", {}, {})).resolves.toBe("idle (no Debug Session)");
      // Every other operation leaves them out of text.
      for (const operation of ["continue"] as const) {
        await expect(
          textOf(operation, {}, { desiredBreakpoints, snapshot: stoppedSnapshot }),
        ).resolves.toBe("stopped (breakpoint) · thread 1");
      }
      expect(
        await textOf("set_breakpoints", { file_path: existingFile, breakpoints: [] }, {}),
      ).toBe(
        "Saved; breakpoints apply to the next launch (no active Debug Session).\nDesired Breakpoints: none",
      );
    });

    test("refused child sessions are named in the text, with what to do, and in structuredContent", async () => {
      const rejectedChildSessions = [
        {
          type: "pwa-node",
          name: "forks.js [42]",
          targetId: "t-1",
          message:
            'HL DAP refused child session pwa-node "forks.js [42]" (target t-1): child debugging is unsupported, so breakpoints in it will not bind. The child runs without a debugger.',
        },
      ];
      const running = {
        snapshot: { state: "running", adapterId: "n", profileId: "p" },
      } as const;
      const text = await textOf("launch", {}, { ...running, rejectedChildSessions });
      expect(text).toBe(
        [
          "running (wait timed out)",
          `Warning: ${rejectedChildSessions[0]?.message}`,
          "To debug that code, launch it directly as the program.",
        ].join("\n"),
      );
      await expect(textOf("status", {}, { ...running })).resolves.toBe("running");

      const fixture = await createToolFixture();
      fixture.session.result = {
        ...running,
        output: "",
        discardedOutputBytes: 0,
        desiredBreakpoints: [],
        rejectedChildSessions,
      };
      for (const operation of ["launch", "continue", "status"] as const) {
        const result = await dapTool(() => fixture.runtime, operation).execute(
          operation,
          {},
          undefined,
          undefined,
          fixture.context,
        );
        expectDapToolOutput(operation, result);
        expect(result.structuredContent).toMatchObject({
          rejected_child_sessions: [
            {
              type: "pwa-node",
              name: "forks.js [42]",
              target_id: "t-1",
              message: rejectedChildSessions[0]?.message,
            },
          ],
        });
      }
      const many = Array.from({ length: 7 }, (_, index) => ({
        message: `refused ${index}`,
      }));
      const manyText = await textOf("status", {}, { ...running, rejectedChildSessions: many });
      expect(manyText).toContain("Warning: refused 4\n");
      expect(manyText).not.toContain("refused 5");
      expect(manyText).toContain("Warning: 2 more child sessions not debugged");
    });

    test("stack, variables, and evaluate are one line per row and never raw JSON", async () => {
      const stack = await textOf(
        "stack",
        {},
        {
          snapshot: stoppedSnapshot,
          stackFrames: [
            {
              id: 12,
              name: "add",
              line: 3,
              column: 5,
              source: { path: "/elsewhere/app.js" },
            },
            { id: 13, name: "main", line: 9, column: 1 },
          ],
          totalFrames: 5,
        },
      );
      expect(stack).toBe(
        "Stack: 2 of 5 frames\n  frame 12: add at /elsewhere/app.js:3:5\n  frame 13: main at 9:1",
      );
      const normalHints = await textOf(
        "stack",
        {},
        {
          snapshot: stoppedSnapshot,
          stackFrames: [
            {
              id: 1,
              name: "a",
              line: 1,
              column: 1,
              presentationHint: "normal",
            },
            {
              id: 2,
              name: "b",
              line: 2,
              column: 1,
              source: { name: "b.js", presentationHint: "emphasize" },
            },
          ],
        },
      );
      expect(normalHints).toBe("Stack: 2 frames\n  frame 1: a at 1:1\n  frame 2: b at b.js:2:1");
      const variables = await textOf(
        "variables",
        { frame_id: 12 },
        {
          snapshot: stoppedSnapshot,
          variableGroups: [
            {
              scope: { name: "Local", variablesReference: 5, expensive: false },
              variables: [
                {
                  name: "a",
                  value: "1",
                  type: "number",
                  variablesReference: 0,
                },
                { name: "obj", value: "Object", variablesReference: 8 },
              ],
            },
          ],
        },
      );
      expect(variables).toBe(
        "Scope Local [variables_reference 5]: 2 variables\n  a: number = 1\n  obj = Object [variables_reference 8]",
      );
      const evaluation = await textOf(
        "evaluate",
        { expression: "a + 1" },
        {
          snapshot: stoppedSnapshot,
          evaluation: { result: "2", type: "number", variablesReference: 0 },
        },
      );
      expect(evaluation).toBe("2 (number)");
      for (const text of [stack, variables, evaluation]) expect(text).not.toMatch(/[{}"]/u);
    });

    test("stack collapses each run of subtle, label, and deemphasized-source frames into one line", async () => {
      const deemphasized = {
        line: 1,
        column: 1,
        source: { presentationHint: "deemphasize" },
      } as const;
      const stack = await textOf(
        "stack",
        {},
        {
          snapshot: stoppedSnapshot,
          stackFrames: [
            {
              id: 32,
              name: "fib",
              line: 5,
              column: 5,
              source: { path: "/elsewhere/prog.mjs" },
            },
            { id: 34, name: "ModuleJob.run", ...deemphasized },
            {
              id: 35,
              name: "processTicks",
              line: 105,
              column: 5,
              presentationHint: "subtle",
            },
            {
              id: 36,
              name: "await",
              line: 0,
              column: 0,
              presentationHint: "label",
            },
            { id: 37, name: "main", line: 12, column: 16 },
            {
              id: 40,
              name: "await",
              line: 0,
              column: 0,
              presentationHint: "label",
            },
            { id: 41, name: "user", line: 3, column: 1 },
            { id: 50, name: "x", ...deemphasized },
            { id: 52, name: "y", ...deemphasized },
            { id: 51, name: "z", ...deemphasized },
          ],
          totalFrames: 40,
        },
      );
      expect(stack).toBe(
        [
          "Stack: 10 of 40 frames",
          "  frame 32: fib at /elsewhere/prog.mjs:5:5",
          "  … 3 deemphasized frames (ids 34–36)",
          "  frame 37: main at 12:16",
          "  frame 40: await at 0:0",
          "  frame 41: user at 3:1",
          "  … 3 deemphasized frames (ids 50, 52, 51)",
        ].join("\n"),
      );
    });
  });

  test("publishes immediate one-second progress only for execution waits and clears its timer", async () => {
    vi.useFakeTimers();
    const fixture = await createToolFixture();
    let release: () => void = () => undefined;
    fixture.session.wait = new Promise<void>((resolveWait) => {
      release = resolveWait;
    });
    const onUpdate = vi.fn<AgentToolUpdateCallback<DapToolRenderDetails | undefined>>();
    const execution = dapTool(() => fixture.runtime, "continue").execute(
      "continue",
      {},
      undefined,
      onUpdate,
      fixture.context,
    );
    expect(onUpdate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onUpdate).toHaveBeenCalledTimes(3);
    expect(onUpdate.mock.calls.map(([update]) => update.details)).toEqual([
      { kind: "progress", operation: "continue", elapsed_ms: 0 },
      { kind: "progress", operation: "continue", elapsed_ms: 1_000 },
      { kind: "progress", operation: "continue", elapsed_ms: 2_000 },
    ]);
    release();
    await execution;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onUpdate).toHaveBeenCalledTimes(3);

    fixture.session.wait = undefined;
    onUpdate.mockClear();
    await dapTool(() => fixture.runtime, "status").execute(
      "status",
      {},
      undefined,
      onUpdate,
      fixture.context,
    );
    expect(onUpdate).not.toHaveBeenCalled();
  });

  test("marks a cancelled execution wait in its text and structured result", async () => {
    const fixture = await createToolFixture();
    fixture.session.result = {
      snapshot: { state: "running", adapterId: "node", profileId: "node" },
      output: "",
      discardedOutputBytes: 0,
      desiredBreakpoints: [],
    };
    const controller = new AbortController();
    controller.abort();
    const result = await dapTool(() => fixture.runtime, "continue").execute(
      "cancelled",
      {},
      controller.signal,
      undefined,
      fixture.context,
    );
    expect(result.content).toEqual([
      {
        type: "text",
        text: "running (wait cancelled)",
      },
    ]);
    expect(result.details).toMatchObject({
      presentation: {
        kind: "execution_wait",
        operation: "continue",
        cancelled: true,
      },
    });
    expect(result.structuredContent).toMatchObject({
      state: "running",
      execution_wait_cancelled: true,
    });
  });

  test("says a pause whose wait ended without a stop did not stop the Debuggee", async () => {
    const fixture = await createToolFixture();
    fixture.session.result = {
      snapshot: { state: "running", adapterId: "node", profileId: "node" },
      output: "",
      discardedOutputBytes: 0,
      desiredBreakpoints: [],
    };
    const result = await dapTool(() => fixture.runtime, "pause").execute(
      "pause",
      {},
      undefined,
      undefined,
      fixture.context,
    );
    expect(result.content).toEqual([{ type: "text", text: "running (no stop after pause)" }]);
  });

  test("does not mark a cancelled wait whose Debuggee already exited", async () => {
    const fixture = await createToolFixture();
    fixture.session.result = {
      snapshot: {
        state: "terminated",
        adapterId: "node",
        profileId: "node",
        exitCode: 0,
      },
      output: "",
      discardedOutputBytes: 0,
      desiredBreakpoints: [],
    };
    const controller = new AbortController();
    controller.abort();
    const result = await dapTool(() => fixture.runtime, "continue").execute(
      "cancelled",
      {},
      controller.signal,
      undefined,
      fixture.context,
    );
    expect(result.structuredContent).toMatchObject({ state: "terminated" });
    expect(result.structuredContent).not.toHaveProperty("execution_wait_cancelled");
  });

  describe("Steer Yield", () => {
    const runningResult = (): DapResult => ({
      snapshot: { state: "running", adapterId: "node", profileId: "node" },
      output: "",
      discardedOutputBytes: 0,
      desiredBreakpoints: [],
    });

    test.each(["launch", "continue"] as const)(
      "hl_dap_%s ends its wait when a steer is queued during it and reports it as steered",
      async (operation) => {
        const fixture = await createToolFixture();
        fixture.session.result = runningResult();
        fixture.session.yieldOnSteer = true;
        const controller = new AbortController();
        const execution = dapTool(() => fixture.runtime, operation).execute(
          "steered",
          {},
          controller.signal,
          undefined,
          fixture.context,
        );
        await vi.waitFor(() => expect(fixture.session.calls).toHaveLength(1));
        const [call] = fixture.session.calls;
        expect(call?.steerSignal?.aborted).toBe(false);

        queueSteering(fixture.context.sessionManager.getSessionId());
        const result = await execution;

        expect(call?.steerSignal?.aborted).toBe(true);
        // A Steer Yield is not the tool signal aborting.
        expect(controller.signal.aborted).toBe(false);
        expect(call?.signal?.aborted).toBe(false);
        expect(result.content).toEqual([{ type: "text", text: "running (wait steered)" }]);
        expect(result.details).toMatchObject({
          state: "running",
          presentation: { kind: "execution_wait", operation, steered: true },
        });
        expect(result.details).not.toMatchObject({
          presentation: { cancelled: true },
        });
        expect(result.structuredContent).toMatchObject({
          state: "running",
          execution_wait_steered: true,
        });
        expect(result.structuredContent).not.toHaveProperty("execution_wait_cancelled");
      },
    );

    test("a steer already pending yields immediately, after the request that resumes was made", async () => {
      const fixture = await createToolFixture();
      fixture.session.result = runningResult();
      fixture.session.yieldOnSteer = true;
      queueSteering(fixture.context.sessionManager.getSessionId());

      const result = await dapTool(() => fixture.runtime, "continue").execute(
        "pending",
        {},
        undefined,
        undefined,
        fixture.context,
      );

      expect(fixture.session.calls.map(({ name }) => name)).toEqual(["continue"]);
      expect(fixture.session.calls[0]?.steerSignal?.aborted).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "running (wait steered)" }]);
      // The steer stays pending until Pi starts the next turn, so the next wait yields too.
      expect(hasSteering(fixture.context.sessionManager.getSessionId())).toBe(true);
    });

    test("hl_dap_pause ignores a pending steer and reports the stop it requested", async () => {
      const fixture = await createToolFixture();
      fixture.session.result = {
        snapshot: {
          state: "stopped",
          adapterId: "node",
          profileId: "node",
          stopReason: "pause",
        },
        output: "",
        discardedOutputBytes: 0,
        desiredBreakpoints: [],
      };
      fixture.session.yieldOnSteer = true;
      queueSteering(fixture.context.sessionManager.getSessionId());

      const result = await dapTool(() => fixture.runtime, "pause").execute(
        "pause",
        {},
        undefined,
        undefined,
        fixture.context,
      );

      expect(fixture.session.calls[0]?.steerSignal).toBeUndefined();
      expect(result.structuredContent).toMatchObject({ state: "stopped" });
      expect(result.structuredContent).not.toHaveProperty("execution_wait_steered");
      expect(JSON.stringify(result.content)).not.toContain("steered");
    });

    test("a wait that ended with a stop is reported as that stop, not as steered", async () => {
      const fixture = await createToolFixture();
      fixture.session.result = {
        snapshot: {
          state: "stopped",
          adapterId: "node",
          profileId: "node",
          stopReason: "breakpoint",
        },
        output: "",
        discardedOutputBytes: 0,
        desiredBreakpoints: [],
      };
      fixture.session.yieldOnSteer = true;
      queueSteering(fixture.context.sessionManager.getSessionId());

      const result = await dapTool(() => fixture.runtime, "next").execute(
        "stopped",
        {},
        undefined,
        undefined,
        fixture.context,
      );

      expect(result.structuredContent).not.toHaveProperty("execution_wait_steered");
      expect(result.details).not.toMatchObject({
        presentation: { kind: "execution_wait" },
      });
    });
  });

  test("rejects invalid arguments during preparation and execution before runtime or observers", async () => {
    const fixture = await createToolFixture();
    const observer = {
      onToolStart: vi.fn<NonNullable<DapToolRuntime["observer"]>["onToolStart"]>(),
      onToolSuccess: vi.fn<NonNullable<DapToolRuntime["observer"]>["onToolSuccess"]>(),
      onToolFailure: vi.fn<NonNullable<DapToolRuntime["observer"]>["onToolFailure"]>(),
    };
    const getRuntime = vi.fn<() => DapToolRuntime>(() => ({
      ...fixture.runtime,
      observer,
    }));
    const cases: readonly [DapOperation, DapToolInput][] = [
      ["set_breakpoints", { file_path: "a.ts" }],
      ["variables", { frame_id: 0, variables_reference: 1 }],
      ["variables", { variables_reference: -1 }],
      // Fields of another operation are unknown to this tool.
      ["status", { expression: "x" }],
    ];
    for (const [operation, input] of cases) {
      const tool = dapTool(getRuntime, operation);
      expect(tool.prepareArguments).toBeTypeOf("function");
      expect(() => tool.prepareArguments?.(input)).toThrow("HL DAP: invalid tool arguments");
      await expect(
        tool.execute("invalid", input, undefined, undefined, fixture.context),
      ).rejects.toThrow("HL DAP: invalid tool arguments");
    }
    expect(getRuntime).not.toHaveBeenCalled();
    expect(observer.onToolStart).not.toHaveBeenCalled();
    expect(observer.onToolSuccess).not.toHaveBeenCalled();
    expect(observer.onToolFailure).not.toHaveBeenCalled();
    expect(fixture.session.calls).toEqual([]);
  });

  test("names what is wrong with invalid arguments instead of a bare parse failure", async () => {
    const fixture = await createToolFixture();
    const cases: readonly [DapOperation, DapToolInput, RegExp][] = [
      // Both selectors given: the strict ingress contract rejects it and says which field.
      [
        "variables",
        { frame_id: 0, variables_reference: 1 },
        /\/variables_reference is not allowed$/u,
      ],
      ["variables", {}, /arguments must have required properties frame_id$/u],
      ["evaluate", {}, /arguments must have required properties expression$/u],
      ["stack", { count: 0 }, /\/count must be >= 1$/u],
      ["status", { expression: "x" }, /\/expression is not allowed$/u],
    ];
    for (const [operation, input, reason] of cases) {
      const tool = dapTool(() => fixture.runtime, operation);
      expect(() => tool.prepareArguments?.(input), `${operation} ${JSON.stringify(input)}`).toThrow(
        reason,
      );
    }
  });

  describe("hl_dap_set_breakpoints for a source file that does not exist", () => {
    async function setBreakpoints(
      fixture: Awaited<ReturnType<typeof createToolFixture>>,
      input: DapToolInput,
    ) {
      return dapTool(() => fixture.runtime, "set_breakpoints").execute(
        "set-breakpoints",
        input,
        undefined,
        undefined,
        fixture.context,
      );
    }

    test("keeps the Desired Breakpoints and warns the model that they will not bind", async () => {
      const fixture = await createToolFixture();
      const missing = resolve(fixture.cwd, "src/missing.ts");
      const result = await setBreakpoints(fixture, {
        file_path: "src/missing.ts",
        breakpoints: [{ line: 3 }],
      });
      const warning = `file not found locally: ${missing}`;
      expect(fixture.session.calls).toEqual([
        {
          name: "setBreakpoints",
          input: { filePath: missing, breakpoints: [{ line: 3 }] },
        },
      ]);
      expect(result.isError).toBeUndefined();
      expect(result.content[0]).toMatchObject({
        text: stringContaining(warning),
      });
      expect(result.structuredContent).toMatchObject({ warnings: [warning] });
    });

    test("warns that a directory is not a file", async () => {
      const fixture = await createToolFixture();
      await mkdir(resolve(fixture.cwd, "src"));
      const result = await setBreakpoints(fixture, {
        file_path: "src",
        breakpoints: [{ line: 1 }],
      });
      const warning = `not a local file: ${resolve(fixture.cwd, "src")}`;
      expect(fixture.session.calls).toHaveLength(1);
      expect(result.content[0]).toMatchObject({
        text: stringContaining(warning),
      });
      expect(result.structuredContent).toMatchObject({ warnings: [warning] });
    });

    test("does not warn when clearing its breakpoints", async () => {
      const fixture = await createToolFixture();
      const result = await setBreakpoints(fixture, {
        file_path: "src/missing.ts",
        breakpoints: [],
      });
      const withoutMissingFileWarning: unknown = expect.not.stringContaining("file not found");
      expect(result.content[0]).toMatchObject({
        text: withoutMissingFileWarning,
      });
      expect(result.structuredContent).not.toHaveProperty("warnings");
    });
  });

  test("dispatches all operations, maps paths, forwards cancellation, and validates details", async () => {
    const fixture = await createToolFixture();
    const controller = new AbortController();
    const observer = {
      onToolStart: vi.fn<NonNullable<DapToolRuntime["observer"]>["onToolStart"]>(),
      onToolSuccess: vi.fn<NonNullable<DapToolRuntime["observer"]>["onToolSuccess"]>(),
      onToolFailure: vi.fn<NonNullable<DapToolRuntime["observer"]>["onToolFailure"]>(),
    };
    const runtime = { ...fixture.runtime, observer };
    const inputs: readonly [DapOperation, DapToolInput][] = [
      [
        "launch",
        {
          profile: "node",
          program: "src/app.ts",
          args: ["one"],
          cwd: "runtime",
          launch_arguments: {
            autoAttachChildProcesses: false,
            env: { A: "1" },
          },
        },
      ],
      [
        "set_breakpoints",
        {
          file_path: "src/app.ts",
          breakpoints: [{ line: 2, condition: "ready" }],
        },
      ],
      ["continue", {}],
      ["next", {}],
      ["step_in", {}],
      ["step_out", {}],
      ["pause", {}],
      ["stack", { thread_id: 7, start: 1, count: 2 }],
      ["variables", { frame_id: 9, start: 2, count: 3 }],
      ["variables", { variables_reference: 11 }],
      ["evaluate", { expression: "answer", frame_id: 9 }],
      ["status", {}],
      ["stop", {}],
    ];

    for (const [operation, input] of inputs) {
      const tool = dapTool(() => runtime, operation);
      expect(tool.prepareArguments?.(input)).toEqual(input);
      const result = await tool.execute(
        "dap-call",
        input,
        controller.signal,
        undefined,
        fixture.context,
      );
      expect(Value.Check(DapToolResultDetailsSchema, result.details)).toBe(true);
      expect(result.details).toMatchObject({ operation });
    }
    // The Observer UI still keys on the operation each tool performs.
    expect(observer.onToolStart.mock.calls.map(([parameters]) => parameters)).toEqual(
      inputs.map(([operation, input]) => ({ operation, ...input })),
    );
    expect(observer.onToolSuccess).toHaveBeenCalledTimes(inputs.length);

    expect(fixture.session.calls.map(({ name, input }) => ({ name, input }))).toEqual([
      {
        name: "launch",
        input: {
          profile: "node",
          program: resolve(fixture.cwd, "src/app.ts"),
          args: ["one"],
          cwd: resolve(fixture.cwd, "runtime"),
          launchArguments: { autoAttachChildProcesses: false, env: { A: "1" } },
        },
      },
      {
        name: "setBreakpoints",
        input: {
          filePath: resolve(fixture.cwd, "src/app.ts"),
          breakpoints: [{ line: 2, condition: "ready" }],
        },
      },
      { name: "continue", input: undefined },
      { name: "next", input: undefined },
      { name: "stepIn", input: undefined },
      { name: "stepOut", input: undefined },
      { name: "pause", input: undefined },
      { name: "stack", input: { threadId: 7, start: 1, count: 2 } },
      { name: "variables", input: { frameId: 9, start: 2, count: 3 } },
      { name: "variables", input: { variablesReference: 11 } },
      { name: "evaluate", input: { expression: "answer", frameId: 9 } },
      { name: "status", input: undefined },
      { name: "stop", input: undefined },
    ]);
    expect(
      fixture.session.calls
        .filter(({ name }) => name !== "status" && name !== "stop")
        .every(({ signal }) => signal === controller.signal),
    ).toBe(true);
  });

  test("omits absent dispatch fields without dropping zero IDs, offsets, or empty arguments", async () => {
    const fixture = await createToolFixture();
    const cases: [DapOperation, DapToolInput, RecordedDapInput, string[]][] = [
      ["launch", {}, {}, ["profile", "program", "args", "cwd", "launchArguments"]],
      ["launch", { args: [] }, { args: [] }, ["profile", "program", "cwd", "launchArguments"]],
      ["stack", { thread_id: 0, start: 0 }, { threadId: 0, start: 0 }, ["count"]],
      [
        "variables",
        { frame_id: 0, start: 0 },
        { frameId: 0, start: 0 },
        ["variablesReference", "count"],
      ],
      ["evaluate", { expression: "x", frame_id: 0 }, { expression: "x", frameId: 0 }, []],
    ];
    for (const [operation, parameters, expected, absentFields] of cases) {
      await dapTool(() => fixture.runtime, operation).execute(
        "optional-fields",
        parameters,
        undefined,
        undefined,
        fixture.context,
      );
      const input = fixture.session.calls.at(-1)?.input;
      if (input === undefined) throw new Error("Expected recorded dispatch input");
      expect(input).toStrictEqual(expected);
      for (const field of absentFields) expect(Object.hasOwn(input, field)).toBe(false);
    }
  });

  test("accepts the negative thread and Stack Frame ids DAP allows", async () => {
    const fixture = await createToolFixture();
    const cases: [DapOperation, DapToolInput][] = [
      ["stack", { thread_id: -1 }],
      ["variables", { frame_id: -7 }],
      ["evaluate", { expression: "x", frame_id: -7 }],
    ];
    for (const [operation, parameters] of cases) {
      await dapTool(() => fixture.runtime, operation).execute(
        "negative-ids",
        parameters,
        undefined,
        undefined,
        fixture.context,
      );
    }
    fixture.session.result = {
      snapshot: {
        state: "stopped",
        adapterId: "node",
        profileId: "node",
        stopReason: "breakpoint",
        threadId: -1,
      },
      output: "",
      discardedOutputBytes: 0,
      desiredBreakpoints: [],
      stop: { topFrame: { id: -7, name: "add", line: 3, column: 5 } },
    };
    const result = await dapTool(() => fixture.runtime, "continue").execute(
      "negative-ids",
      {},
      undefined,
      undefined,
      fixture.context,
    );

    expect(fixture.session.calls.map(({ input }) => input)).toStrictEqual([
      { threadId: -1 },
      { frameId: -7 },
      { expression: "x", frameId: -7 },
      undefined,
    ]);
    expect(result.structuredContent).toMatchObject({
      thread_id: -1,
      top_frame: { id: -7 },
    });
  });

  test("points the model at the troubleshooting Skill only for failures it diagnoses", async () => {
    const fixture = await createToolFixture();
    const tool = dapTool(() => fixture.runtime, "launch");
    const adapterFailure = new DapError("adapter", "launch failed: spawn ENOENT");
    const protocolCancelled = new DapConnectionError(
      "cancelled",
      "node",
      "/tmp/stderr.log",
      "launch request was cancelled",
    );
    const failures: readonly [Error, boolean][] = [
      [adapterFailure, true],
      [new DapConnectionError("exit", "node", "/tmp/stderr.log", "adapter exited"), true],
      [
        new DapConnectionError("request", "node", "/tmp/stderr.log", "evaluate request failed"),
        false,
      ],
      [protocolCancelled, false],
      [
        new DapError("adapter", "launch was cancelled and cleaned up", {
          cause: protocolCancelled,
        }),
        false,
      ],
    ];
    for (const [failure, hinted] of failures) {
      vi.spyOn(fixture.session, "launch").mockRejectedValueOnce(failure);
      const error = await tool.execute("failure", {}, undefined, undefined, fixture.context).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      if (!(error instanceof Error)) throw new Error("Expected launch to fail");
      expect(error.message.startsWith("HL DAP: ")).toBe(true);
      expect(error.message.includes(TROUBLESHOOTING_HINT)).toBe(hinted);
      expect(error.message.includes(`\n\n${TROUBLESHOOTING_HINT}`)).toBe(hinted);
    }
  });

  test("reports a Debug Session state failure as an error result that keeps the current state", async () => {
    const fixture = await createToolFixture();
    const observer = {
      onToolStart: vi.fn<NonNullable<DapToolRuntime["observer"]>["onToolStart"]>(),
      onToolSuccess: vi.fn<NonNullable<DapToolRuntime["observer"]>["onToolSuccess"]>(),
      onToolFailure: vi.fn<NonNullable<DapToolRuntime["observer"]>["onToolFailure"]>(),
    };
    fixture.session.result = {
      snapshot: {
        state: "terminated",
        adapterId: "node",
        profileId: "node",
        exitCode: 3,
        terminationReason: "exited",
      },
      output: "unread",
      discardedOutputBytes: 0,
      desiredBreakpoints: [],
    };
    vi.spyOn(fixture.session, "stack").mockRejectedValueOnce(
      new DapError("state", "stack requires a stopped Debuggee"),
    );
    const result = await dapTool(() => ({ ...fixture.runtime, observer }), "stack").execute(
      "state",
      {},
      undefined,
      undefined,
      fixture.context,
    );
    const state = {
      state: "terminated",
      adapter_id: "node",
      profile_id: "node",
      exit_code: 3,
      termination_reason: "exited",
    };
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: `HL DAP: DAP Session: stack requires a stopped Debuggee\nDebug Session: ${JSON.stringify(state)}`,
        },
      ],
      details: undefined,
      structuredContent: {
        ...state,
        error: "HL DAP: DAP Session: stack requires a stopped Debuggee",
      },
      isError: true,
    });
    expect(result.content[0]).not.toMatchObject({
      text: stringContaining(TROUBLESHOOTING_HINT),
    });
    expect(observer.onToolFailure).toHaveBeenCalledOnce();
    expect(observer.onToolSuccess).not.toHaveBeenCalled();
    // The state comes from the snapshot: a failed call does not drain unread Debuggee output.
    expect(fixture.session.calls.map(({ name }) => name)).not.toContain("status");
  });

  test("reports each cleanup cause an aggregate failure holds", async () => {
    const fixture = await createToolFixture();
    const cleanupFailure = (): DapError =>
      new DapError("adapter", "Debug Session cleanup failed", {
        cause: new AggregateError(
          [
            new Error("adapter crashed"),
            new AggregateError(
              [new Error("kill EPERM"), new Error("Owned process group remains present")],
              "Owned process group cleanup failed",
            ),
          ],
          "Debug Session failure and cleanup failures",
        ),
      });
    vi.spyOn(fixture.session, "launch").mockRejectedValueOnce(
      new DapError("state", "previous cleanup failed", {
        cause: cleanupFailure(),
      }),
    );
    vi.spyOn(fixture.session, "stop").mockRejectedValueOnce(cleanupFailure());
    const causes = "causes: adapter crashed; kill EPERM; Owned process group remains present";

    const launched = await dapTool(() => fixture.runtime, "launch").execute(
      "launch",
      {},
      undefined,
      undefined,
      fixture.context,
    );
    expect(launched.structuredContent).toMatchObject({
      error: stringContaining(causes),
    });
    await expect(
      dapTool(() => fixture.runtime, "stop").execute(
        "stop",
        {},
        undefined,
        undefined,
        fixture.context,
      ),
    ).rejects.toThrow(causes);
  });

  test("reports a cyclic aggregate failure once per cause", async () => {
    const fixture = await createToolFixture();
    const leaf = new Error("kill EPERM");
    const aggregate = new AggregateError([leaf], "Debug Session failure and cleanup failures");
    const failure = new DapError("adapter", "Debug Session cleanup failed", {
      cause: aggregate,
    });
    aggregate.errors.push(aggregate, failure);
    leaf.cause = failure;
    vi.spyOn(fixture.session, "stop").mockRejectedValueOnce(failure);
    const stopped = dapTool(() => fixture.runtime, "stop").execute(
      "stop",
      {},
      undefined,
      undefined,
      fixture.context,
    );
    await expect(stopped).rejects.toThrow("Debug Session cleanup failed; causes: kill EPERM");
    await expect(stopped).rejects.not.toThrow("kill EPERM;");
  });

  test("reports the causes after an undefined aggregate member", async () => {
    const fixture = await createToolFixture();
    vi.spyOn(fixture.session, "stop").mockRejectedValueOnce(
      new DapError("adapter", "Debug Session cleanup failed", {
        cause: new AggregateError([undefined, new Error("kill EPERM")], "cleanup failures"),
      }),
    );
    await expect(
      dapTool(() => fixture.runtime, "stop").execute(
        "stop",
        {},
        undefined,
        undefined,
        fixture.context,
      ),
    ).rejects.toThrow("causes: undefined; kill EPERM");
  });

  test("bounds the cleanup causes it reports", async () => {
    const fixture = await createToolFixture();
    const errors = Array.from({ length: 12 }, (_, index) => new Error(`cause ${index + 1}`));
    vi.spyOn(fixture.session, "stop").mockRejectedValueOnce(
      new DapError("adapter", "Debug Session cleanup failed", {
        cause: new AggregateError(errors, "Debug Session failure and cleanup failures"),
      }),
    );
    const failure = dapTool(() => fixture.runtime, "stop").execute(
      "stop",
      {},
      undefined,
      undefined,
      fixture.context,
    );
    await expect(failure).rejects.toThrow("cause 5; and 7 more");
    await expect(failure).rejects.not.toThrow("cause 6");
  });

  test("caps stack presentation at 20 rows without dropping returned frames", async () => {
    const fixture = await createToolFixture();
    const frames = Array.from({ length: 25 }, (_, index) => ({
      id: index + 1,
      name: `frame-${index + 1}`,
      line: index + 1,
      column: 1,
    }));
    fixture.session.result = {
      snapshot: {
        state: "stopped",
        adapterId: "node",
        profileId: "node",
        stopReason: "breakpoint",
      },
      output: "",
      discardedOutputBytes: 0,
      desiredBreakpoints: [],
      stackFrames: frames,
      totalFrames: 30,
    };
    const result = await dapTool(() => fixture.runtime, "stack").execute(
      "stack",
      { count: 25 },
      undefined,
      undefined,
      fixture.context,
    );
    expect(result.structuredContent).toMatchObject({
      stack_frames: frames,
      total_frames: 30,
    });
    const details = Value.Parse(DapToolResultDetailsSchema, result.details);
    expect(details.presentation).toMatchObject({
      kind: "stack_frames",
      total_count: 30,
      omitted_count: 10,
    });
    if (details.presentation?.kind !== "stack_frames")
      throw new Error("Expected stack presentation");
    expect(details.presentation.rows).toHaveLength(20);
    expect(details.presentation.rows[19]).toEqual({
      id: 20,
      name: "frame-20",
      line: 20,
      column: 1,
    });
  });

  test("caps breakpoint presentation at 20 rows without dropping breakpoint data", async () => {
    const fixture = await createToolFixture();
    const filePath = resolve(fixture.cwd, "app.ts");
    await writeFile(filePath, "");
    const requested = Array.from({ length: 25 }, (_, index) => ({
      line: index + 1,
    }));
    const breakpoints = Array.from({ length: 25 }, (_, index) => ({
      id: index + 1,
      verified: true,
      line: index + 1,
    }));
    fixture.session.result = {
      snapshot: {
        state: "stopped",
        adapterId: "node",
        profileId: "node",
        stopReason: "breakpoint",
      },
      output: "",
      discardedOutputBytes: 0,
      desiredBreakpoints: [{ filePath, breakpoints: requested }],
      breakpoints,
    };
    const result = await dapTool(() => fixture.runtime, "set_breakpoints").execute(
      "breakpoints",
      { file_path: "app.ts", breakpoints: requested },
      undefined,
      undefined,
      fixture.context,
    );
    expect(result.structuredContent).toMatchObject({
      breakpoints,
      desired_breakpoints: [{ file_path: filePath, breakpoints: requested }],
    });
    const details = Value.Parse(DapToolResultDetailsSchema, result.details);
    expect(details.presentation).toMatchObject({
      kind: "breakpoints",
      omitted_count: 5,
    });
    if (details.presentation?.kind !== "breakpoints")
      throw new Error("Expected breakpoint presentation");
    expect(details.presentation.rows).toHaveLength(20);
    expect(details.presentation.rows[19]).toEqual({
      id: 20,
      verified: true,
      line: 20,
    });
  });

  test.each([
    {
      name: "at 500 UTF-16 units",
      value: `${"x".repeat(498)}😀`,
      expected: `${"x".repeat(498)}😀`,
    },
    {
      name: "beyond 500 UTF-16 units",
      value: `${"x".repeat(498)}😀z`,
      expected: `${"x".repeat(498)}…`,
    },
  ])("keeps Unicode intact in presentation $name", async ({ value, expected }) => {
    const fixture = await createToolFixture();
    fixture.session.result = {
      snapshot: {
        state: "stopped",
        adapterId: "node",
        profileId: "node",
        stopReason: "breakpoint",
      },
      output: "",
      discardedOutputBytes: 0,
      desiredBreakpoints: [],
      evaluation: { result: value, variablesReference: 0 },
    };
    const result = await dapTool(() => fixture.runtime, "evaluate").execute(
      "evaluate",
      { expression: "text" },
      undefined,
      undefined,
      fixture.context,
    );
    expect(result.structuredContent).toMatchObject({
      evaluation: { result: value, variables_reference: 0 },
    });
    expect(result.content).toEqual([{ type: "text", text: value }]);
    expect(result.details).toMatchObject({
      presentation: {
        kind: "evaluation",
        value: expected,
        variables_reference: 0,
      },
    });
    expect(Value.Check(DapToolResultDetailsSchema, result.details)).toBe(true);
  });

  test("preserves a completed mutating action when Result Spill storage rejects", async () => {
    const fixture = await createToolFixture();
    const output = "retained output\n".repeat(6_000);
    fixture.session.result = {
      snapshot: {
        state: "stopped",
        adapterId: "node",
        profileId: "node",
        stopReason: "breakpoint",
        threadId: 7,
      },
      output,
      discardedOutputBytes: 12,
      desiredBreakpoints: [],
      evaluation: { result: "1", type: "number", variablesReference: 0 },
    };
    const observer = {
      onToolStart: vi.fn<NonNullable<DapToolRuntime["observer"]>["onToolStart"]>(),
      onToolSuccess: vi.fn<NonNullable<DapToolRuntime["observer"]>["onToolSuccess"]>(),
      onToolFailure: vi.fn<NonNullable<DapToolRuntime["observer"]>["onToolFailure"]>(),
    };
    await fixture.runtime.artifacts.dispose();
    const result = await dapTool(() => ({ ...fixture.runtime, observer }), "evaluate").execute(
      "evaluate",
      { expression: "counter += 1" },
      undefined,
      undefined,
      fixture.context,
    );
    expect(fixture.session.calls.map(({ name }) => name)).toEqual(["evaluate"]);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      state: "stopped",
      adapter_id: "node",
      profile_id: "node",
      stop_reason: "breakpoint",
      thread_id: 7,
      output,
      output_discarded_bytes: 12,
      evaluation: { result: "1", type: "number", variables_reference: 0 },
    });
    expect(result.details).toMatchObject({
      operation: "evaluate",
      state: "stopped",
      output_truncated: true,
      spill_error: "HL DAP: session files are closed",
    });
    expect(result.details).not.toHaveProperty("spill_path");
    expect(Value.Check(DapToolResultDetailsSchema, result.details)).toBe(true);
    const text = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("");
    expect(
      text.startsWith("1 (number)\n\nDebuggee output (12 older bytes discarded):\nretained output"),
    ).toBe(true);
    expect(text).toMatch(
      /\n\nWarning: Result Spill storage failed after the action completed; output truncated\. Do not repeat the call\. Cause: HL DAP: session files are closed$/u,
    );
    expect(text).not.toContain("structuredContent");
    expect(text).not.toContain("complete Result Spill:");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(50 * 1024);
    expect(text.split("\n").length).toBeLessThanOrEqual(2_000);
    expect(observer.onToolSuccess).toHaveBeenCalledOnce();
    expect(observer.onToolFailure).not.toHaveBeenCalled();
  });

  test("keeps the start of a huge evaluation beside a bounded spill-failure cause", async () => {
    const fixture = await createToolFixture();
    const output = "x".repeat(60 * 1024);
    const evaluationValue = "e".repeat(50 * 1024);
    const diagnostic = "ENOSPC: storage unavailable\n".repeat(10_000);
    fixture.session.result = {
      snapshot: {
        state: "stopped",
        adapterId: "node",
        profileId: "node",
        stopReason: "breakpoint",
      },
      output,
      discardedOutputBytes: 0,
      desiredBreakpoints: [],
      evaluation: { result: evaluationValue, variablesReference: 0 },
    };
    const write = vi.spyOn(filesystem, "writeFile").mockRejectedValue(new Error(diagnostic));
    syncBuiltinESMExports();
    try {
      const result = await dapTool(() => fixture.runtime, "evaluate").execute(
        "evaluate",
        { expression: "counter += 1" },
        undefined,
        undefined,
        fixture.context,
      );
      expect(fixture.session.calls.map(({ name }) => name)).toEqual(["evaluate"]);
      expect(write).toHaveBeenCalledOnce();
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        state: "stopped",
        output,
        evaluation: { result: evaluationValue },
      });
      const details = Value.Parse(DapToolResultDetailsSchema, result.details);
      expect(details).toMatchObject({ output_truncated: true });
      expect(details).not.toHaveProperty("spill_path");
      if (details.spill_error === undefined) {
        throw new Error("Expected a bounded spill error");
      }
      // The cause is one line and capped at 500 UTF-16 units, ellipsis included.
      const oneLineDiagnostic = "ENOSPC: storage unavailable\\n".repeat(10_000);
      expect(oneLineDiagnostic).toContain(details.spill_error.slice(0, -1));
      expect(details.spill_error).toMatch(/…$/u);
      expect(details.spill_error.length).toBeLessThanOrEqual(500);
      const text = result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("");
      // The warning takes under 1 KB of Pi's 50-KB budget, so the value keeps its first 50 KB.
      expect(text.startsWith(evaluationValue.slice(0, 50_000))).toBe(true);
      expect(text).toContain(
        "Warning: Result Spill storage failed after the action completed; output truncated. Do not repeat the call. Cause: ENOSPC: storage unavailable",
      );
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(50 * 1024);
      expect(text.split("\n").length).toBeLessThanOrEqual(2_000);
    } finally {
      write.mockRestore();
      syncBuiltinESMExports();
    }
  });

  test("names a storage failure that has no error message", async () => {
    const fixture = await createToolFixture();
    fixture.session.result = {
      snapshot: {
        state: "stopped",
        adapterId: "node",
        profileId: "node",
        stopReason: "breakpoint",
      },
      output: "x".repeat(60 * 1024),
      discardedOutputBytes: 0,
      desiredBreakpoints: [],
      evaluation: { result: "1", variablesReference: 0 },
    };
    const write = vi.spyOn(filesystem, "writeFile").mockRejectedValue(new Error(""));
    syncBuiltinESMExports();
    try {
      const result = await dapTool(() => fixture.runtime, "evaluate").execute(
        "evaluate",
        { expression: "counter += 1" },
        undefined,
        undefined,
        fixture.context,
      );
      expect(result.isError).not.toBe(true);
      const details = Value.Parse(DapToolResultDetailsSchema, result.details);
      expect(details).toMatchObject({
        spill_error: "no error message",
        output_truncated: true,
      });
      const text = result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("");
      expect(text).toMatch(/Cause: no error message$/u);
    } finally {
      write.mockRestore();
      syncBuiltinESMExports();
    }
  });

  test("reparses hook-mutated input before effects and spills complete oversized output", async () => {
    const fixture = await createToolFixture();
    await expect(
      dapTool(() => fixture.runtime, "continue").execute(
        "invalid",
        { thread_id: 1 },
        undefined,
        undefined,
        fixture.context,
      ),
    ).rejects.toThrow("HL DAP: invalid tool arguments");
    expect(fixture.session.calls).toEqual([]);

    fixture.session.result = {
      snapshot: {
        state: "stopped",
        adapterId: "node",
        profileId: "node",
        stopReason: "breakpoint",
        threadId: 7,
      },
      output: "x".repeat(60 * 1024),
      discardedOutputBytes: 12,
      desiredBreakpoints: [],
      stackFrames: [{ id: 42, name: "main", line: 0, column: 0 }],
    };
    const result = await dapTool(() => fixture.runtime, "stack").execute(
      "spilled",
      {},
      undefined,
      undefined,
      fixture.context,
    );
    expect(result.details).toMatchObject({
      operation: "stack",
      state: "stopped",
      adapter_id: "node",
      profile_id: "node",
      stop_reason: "breakpoint",
      thread_id: 7,
      stack_frame_ids: [42],
      output_discarded_bytes: 12,
      output_truncated: true,
      spill_path: anyInstance(String),
    });
    if (result.details === undefined || "kind" in result.details) {
      throw new Error("Expected final DAP result details");
    }
    if (result.details.spill_path === undefined) throw new Error("Expected Result Spill path");
    expect(await readFile(result.details.spill_path, "utf8")).toBe(
      `Stack: 1 frame\n  frame 42: main at 0:0\n\nDebuggee output (12 older bytes discarded):\n${"x".repeat(60 * 1024)}`,
    );
    expect(result.details).not.toHaveProperty("spill_error");
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: stringContaining("complete Result Spill"),
    });
  });
});
