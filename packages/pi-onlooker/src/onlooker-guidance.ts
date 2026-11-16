import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

const fileName = "ONLOOKER.md";

/** Directories from the git root (or home) down to `cwd`; only `cwd` when neither contains it. */
function projectDirs(cwd: string): string[] {
  const home = homedir();
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    dirs.unshift(dir);
    if (existsSync(join(dir, ".git")) || dir === home) return dirs;
    if (dirname(dir) === dir) return [cwd];
  }
}

/** Onlooker-only review guidance, user level first, then outer to inner project directories. */
export function onlookerGuidance(cwd: string, agentDir: string): string[] {
  const candidates = [
    { path: join(agentDir, fileName), project: false },
    ...projectDirs(cwd).flatMap((dir) => {
      const root = realpathSync(dir);
      return [fileName, join(CONFIG_DIR_NAME, fileName)].map((name) => ({
        path: join(root, name),
        project: true,
      }));
    }),
  ];
  return candidates
    .filter(({ path }) => existsSync(path))
    .map(({ path, project }) => {
      if (project && realpathSync(path) !== path)
        throw new Error(`Onlooker guidance cannot follow project symlinks: ${path}`);
      return readFileSync(path, "utf8").trim();
    })
    .filter(Boolean)
    .map((text) => `Especially pay attention to:\n<attention>\n${text}\n</attention>`);
}
