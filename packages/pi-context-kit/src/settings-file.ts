import { readFileSync } from "node:fs";
import { join } from "node:path";

import { errorText } from "pi-hl-utils/errors";
import { isRecord } from "pi-hl-utils/record";

const FILE_NAME = "context-kit.json";

export interface SettingsPaths {
  global: string;
  /** Undefined in an untrusted project, as Pi does for its own project settings. */
  project: string | undefined;
}

export function settingsPaths(agentDir: string, cwd: string, trusted: boolean): SettingsPaths {
  return {
    global: join(agentDir, FILE_NAME),
    project: trusted ? join(cwd, ".pi", FILE_NAME) : undefined,
  };
}

/** The content of one settings file, `{}` when it does not exist. Throws when it is not a JSON object. */
export function readSettingsFile(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return {};
    throw new Error(`${path} cannot be read (${errorText(error)})`, {
      cause: error,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${errorText(error)})`, {
      cause: error,
    });
  }
  if (!isRecord(value)) throw new Error(`${path} must contain a JSON object`);
  return value;
}

/**
 * Merges `over` into `base` like Pi merges project settings over global ones: objects merge key by
 * key; any other value, including a list, replaces the base value.
 */
export function mergeSettings(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = result[key];
    // A plain assignment of "__proto__" would set the prototype instead of a key.
    Object.defineProperty(result, key, {
      value: isRecord(current) && isRecord(value) ? mergeSettings(current, value) : value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}
