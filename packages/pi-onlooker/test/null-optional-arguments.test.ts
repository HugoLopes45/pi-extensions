import { expectNullOptionalArgumentsOmitted } from "pi-hl-utils/testing/tool-testing";
import { expect, it } from "vitest";

import { fixture } from "./fixtures/onlooker-runtime.js";

it("onlooker_ask treats null for an optional parameter like omitting it", async () => {
  const { session } = await fixture();
  const ask = session.extensionRunner?.getToolDefinition("onlooker_ask");
  if (!ask) throw new Error("Expected the onlooker_ask tool");
  // Its only parameter is required, so there is nothing optional to reject null.
  expect(expectNullOptionalArgumentsOmitted(ask)).toEqual([]);
});
