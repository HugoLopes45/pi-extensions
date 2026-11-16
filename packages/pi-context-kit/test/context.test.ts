import { describe, expect, it } from "vitest";

import { applyEdits, projectedMessages } from "../src/context.ts";
import { Transcript } from "./fixtures.ts";

describe("applyEdits", () => {
  it("replaces string content of a tool result with a text part, as Pi does", () => {
    const t = new Transcript();
    const id = t.tool("bash", { command: "a" }, "output");
    const [, result] = projectedMessages(applyEdits(t.entries(), [{ targetId: id, content: "x" }]));
    expect(result).toMatchObject({
      role: "toolResult",
      content: [{ type: "text", text: "x" }],
    });
  });

  it("rejects content that the target message role cannot hold", () => {
    const t = new Transcript();
    const id = t.user("question");
    const toolCall = {
      type: "toolCall" as const,
      id: "c",
      name: "bash",
      arguments: {},
    };
    expect(() => applyEdits(t.entries(), [{ targetId: id, content: [toolCall] }])).toThrow(
      "cannot hold",
    );
  });
});
