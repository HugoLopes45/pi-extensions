import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh directory under the OS temporary directory; it is not removed after the test. */
export async function directory() {
  return realpath(await mkdtemp(join(tmpdir(), "hl-lsp-fixture-")));
}
