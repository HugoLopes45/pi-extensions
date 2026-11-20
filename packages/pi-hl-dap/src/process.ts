import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** Merge configured environment overrides over the parent environment; null removes an inherited key. */
export function resolveProcessEnvironment(
  configured: Readonly<Record<string, string | null>>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(configured)) {
    if (value === null) delete environment[name];
    else environment[name] = value;
  }
  return environment;
}

/** Signal an owned POSIX process group, including descendants after the leader exits; Windows signals only the child. */
export function signalOwnedProcessGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  } catch (cause) {
    const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
    if (code !== "ESRCH") throw cause;
  }
}

export function probeOwnedProcessGroup(child: ChildProcessWithoutNullStreams): boolean | Error {
  if (child.pid === undefined) return false;
  if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (cause) {
    const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
    if (code === "ESRCH") return false;
    // Darwin can report EPERM while an exited group leader awaits reaping.
    if (code === "EPERM" && cause instanceof Error) return cause;
    throw cause;
  }
}

export async function waitForOwnedProcessGroupExit(
  child: ChildProcessWithoutNullStreams,
  deadline: number,
): Promise<boolean> {
  while (probeOwnedProcessGroup(child) !== false) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(10, remaining)));
  }
  return true;
}

/** Stop an owned process group by the deadline, rejecting unless its exit is confirmed. */
export async function stopOwnedProcessGroup(
  child: ChildProcessWithoutNullStreams,
  deadline: number,
): Promise<void> {
  if (probeOwnedProcessGroup(child) === false) return;
  // A refused SIGTERM still escalates to SIGKILL; every failure is reported once the group is handled.
  const failures: Error[] = [];
  try {
    signalOwnedProcessGroup(child, "SIGTERM");
    const termDeadline = Date.now() + Math.max(0, Math.floor((deadline - Date.now()) / 2));
    if (await waitForOwnedProcessGroupExit(child, termDeadline)) return;
  } catch (cause) {
    addFailure(failures, asError(cause, "Owned process group SIGTERM failed"));
  }
  try {
    signalOwnedProcessGroup(child, "SIGKILL");
    await waitForOwnedProcessGroupExit(child, deadline);
    const group = probeOwnedProcessGroup(child);
    if (group !== false) {
      addFailure(
        failures,
        group instanceof Error ? group : new Error("Owned process group remains present"),
      );
    }
  } catch (cause) {
    addFailure(failures, asError(cause, "Owned process group SIGKILL failed"));
  }
  const [first, ...rest] = failures;
  if (first === undefined) return;
  if (rest.length === 0) throw first;
  throw new AggregateError(failures, "Owned process group cleanup failed");
}

/** A signal that rethrows the error object it already threw adds no diagnosis. */
function addFailure(failures: Error[], failure: Error): void {
  if (!failures.includes(failure)) failures.push(failure);
}

function asError(cause: unknown, message: string): Error {
  return cause instanceof Error ? cause : new Error(message, { cause });
}

export async function waitUntil(promise: Promise<void>, deadline: number): Promise<boolean> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), remaining);
    timer.unref();
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
