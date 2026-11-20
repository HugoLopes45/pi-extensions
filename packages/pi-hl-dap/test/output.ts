import { expectToolOutputMatches } from "pi-hl-utils/testing/tool-testing";

import { DAP_OPERATIONS, DapToolOutputSchemas, type DapOperation } from "../src/schemas.js";

/** Operations whose calls never fail because of the Debug Session state. */
export const NEVER_STATE_FAILING: readonly DapOperation[] = ["set_breakpoints", "status", "stop"];

/** Operations whose output schema declares `desired_breakpoints`. */
export const DESIRED_BREAKPOINT_OPERATIONS: readonly DapOperation[] = DAP_OPERATIONS.filter(
  (operation) => "desired_breakpoints" in DapToolOutputSchemas[operation].properties,
);

/**
 * Assert a tool result's `structuredContent` satisfies its operation's declared `outputSchema`.
 * Codemode hands scripts exactly this value, so every executed result, including state-failure
 * and cancelled-wait results, must conform.
 */
export function expectDapToolOutput(
  operation: DapOperation,
  result: { readonly structuredContent?: unknown; readonly isError?: boolean },
): void {
  // `expectToolOutputMatches` lets an error result omit it; DAP's state failures still carry it.
  if (result.structuredContent === undefined)
    throw new Error(`hl_dap_${operation} must return structuredContent`);
  expectToolOutputMatches(
    {
      name: `hl_dap_${operation}`,
      outputSchema: DapToolOutputSchemas[operation],
    },
    result,
  );
}
