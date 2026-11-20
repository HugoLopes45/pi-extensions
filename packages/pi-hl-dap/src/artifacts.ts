import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Maximum unread Debuggee output retained in bytes. */
export const DAP_MAX_OUTPUT_BYTES = 1024 * 1024;

/** One drain of unread Debuggee output. */
export interface DapOutputChunk {
  readonly discardedBytes: number;
  readonly text: string;
}

/** Retains only bounded unread Debuggee output until a tool operation drains it. */
export class DapOutputBuffer {
  private content = Buffer.alloc(0);
  private discardedBytes = 0;

  /** Append Debuggee output in protocol event order. */
  append(output: string): void {
    const combined = Buffer.concat([this.content, Buffer.from(output)]);
    let overflow = Math.max(0, combined.length - DAP_MAX_OUTPUT_BYTES);
    while (overflow < combined.length && ((combined[overflow] ?? 0) & 0xc0) === 0x80) overflow++;
    this.discardedBytes += overflow;
    this.content = overflow === 0 ? combined : Buffer.from(combined.subarray(overflow));
  }

  /** Return and clear all currently unread Debuggee output. */
  drain(): DapOutputChunk {
    const drained = {
      discardedBytes: this.discardedBytes,
      text: this.content.toString("utf8"),
    };
    this.content = Buffer.alloc(0);
    this.discardedBytes = 0;
    return drained;
  }
}

/** Owns private Result Spill and adapter stderr paths for one Pi session. */
export interface DapArtifacts {
  /** Private directory removed when the Pi session shuts down. */
  readonly directoryPath: string;
  /** Write complete truncated tool output to a Result Spill file. */
  writeResultSpill(output: string): Promise<string>;
  /** Create a private stderr file path for one Debug Adapter launch. */
  getAdapterStderrPath(): Promise<string>;
  /** Remove all session files after queued writes finish. */
  dispose(): Promise<void>;
}

class DapArtifactStore implements DapArtifacts {
  private closed = false;
  private disposePromise: Promise<void> | undefined;
  private nextFileIndex = 0;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(readonly directoryPath: string) {}

  writeResultSpill(output: string): Promise<string> {
    const path = join(this.directoryPath, `result-spill-${this.nextFileIndex++}.txt`);
    return this.enqueueWrite(async () => {
      await writeFile(path, output, { encoding: "utf8", mode: 0o600 });
      await chmod(path, 0o600);
      return path;
    });
  }

  getAdapterStderrPath(): Promise<string> {
    const path = join(this.directoryPath, `adapter-stderr-${this.nextFileIndex++}.log`);
    return this.enqueueWrite(async () => {
      await writeFile(path, "", { mode: 0o600 });
      await chmod(path, 0o600);
      return path;
    });
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise;
    this.closed = true;
    this.disposePromise = this.writeQueue.then(
      () => rm(this.directoryPath, { force: true, recursive: true }),
      () => rm(this.directoryPath, { force: true, recursive: true }),
    );
    return this.disposePromise;
  }

  private enqueueWrite<T>(write: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("HL DAP: session files are closed"));
    const result = this.writeQueue.then(write);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Create a private directory for Result Spills and Debug Adapter stderr. */
export async function createDapArtifacts(sessionDirectory: string): Promise<DapArtifacts> {
  const parentDirectory = sessionDirectory.length > 0 ? sessionDirectory : tmpdir();
  await mkdir(parentDirectory, { mode: 0o700, recursive: true });
  const directoryPath = await mkdtemp(join(parentDirectory, "pi-hl-dap-"));
  await chmod(directoryPath, 0o700);
  return new DapArtifactStore(directoryPath);
}
