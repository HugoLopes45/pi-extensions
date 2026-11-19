import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "vitest/config";

const temporaryDirectory = realpathSync(tmpdir());
const home = mkdtempSync(join(temporaryDirectory, "pi-hl-lsp-tests-"));

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
    env: {
      TMPDIR: temporaryDirectory,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
      PI_CACHE_RETENTION: "none",
    },
  },
});
