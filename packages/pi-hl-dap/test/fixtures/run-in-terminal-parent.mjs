import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const [, , pidPath, mode] = process.argv;
if (pidPath === undefined) throw new Error("Missing owned fixture PID path");
const descendant = spawn(
  process.execPath,
  [fileURLToPath(new URL("./sigterm-resistant-child.mjs", import.meta.url)), pidPath],
  { stdio: ["ignore", "pipe", "ignore"] },
);
await once(descendant.stdout, "data");
if (descendant.pid === undefined) throw new Error("Missing fixture descendant PID");
await writeFile(pidPath, `${process.pid}\n${descendant.pid}\n`);
descendant.stdout.destroy();
descendant.unref();
if (mode === "exit") process.exit(0);
setInterval(() => {}, 1_000);
