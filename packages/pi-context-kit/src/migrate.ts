import { isRecord } from "pi-hl-utils/record";

import {
  isMethod,
  isStrategy,
  type Method,
  STRATEGIES,
  type Strategy,
  writesHandoff,
} from "./config.ts";
import { mergeSettings } from "./settings-file.ts";

const NAMES = Object.keys(STRATEGIES).filter(isStrategy);

/** Keys 0.3 had at the top level that 0.4 keeps under `advanced`, unchanged. */
const ADVANCED = ["supersedeReads", "progressRatio", "prune", "shake"];

/** What one scope has before the import: its namespace, its 0.4 file and its 0.3 block. */
export interface ScopeSource {
  /** Whether Pi's settings document of this scope already has the `context-kit` namespace. */
  stored: boolean;
  /** The scope's `context-kit.json`, when that file exists. */
  file?: { path: string; content: Record<string, unknown> };
  /** The 0.3 `contextKit` block of Pi's settings document, when it has one. */
  legacy?: unknown;
}

/** Flat options to write to one scope's `context-kit` namespace, and the file they come from. */
export interface SettingsImport {
  scope: "global" | "project";
  options: Record<string, unknown>;
  /** Renamed to `.migrated` after the options are written. */
  file?: string;
}

/**
 * Plans the import of each scope that has no `context-kit` namespace yet. A scope imports its
 * `context-kit.json` when that file exists, else its 0.3 block. The project block converts over
 * the global settings as they are after this import, as 0.3 merged them.
 */
export function planSettingsImports(
  global: ScopeSource,
  project: ScopeSource | undefined,
): SettingsImport[] {
  const globalNested = nestedGlobal(global);
  const imports: SettingsImport[] = [];
  const globalImport = importOf("global", global, () => globalNested);
  if (globalImport) imports.push(globalImport);
  if (project) {
    const projectImport = importOf("project", project, () =>
      migrateProject(global.legacy ?? {}, project.legacy, globalNested),
    );
    if (projectImport) imports.push(projectImport);
  }
  return imports;
}

function nestedGlobal(global: ScopeSource): Record<string, unknown> {
  if (global.file) return global.file.content;
  return global.legacy === undefined ? {} : migrateLegacy(global.legacy);
}

function importOf(
  scope: SettingsImport["scope"],
  source: ScopeSource,
  legacyNested: () => Record<string, unknown>,
): SettingsImport | undefined {
  if (source.stored) return undefined;
  if (source.file)
    return {
      scope,
      options: flattenSettings(source.file.content),
      file: source.file.path,
    };
  if (source.legacy === undefined) return undefined;
  return { scope, options: flattenSettings(legacyNested()) };
}

/**
 * Converts 0.4 nested options, as `context-kit.json` and the 0.3 conversion write them, to the
 * flat keys of the `context-kit` namespace. A nested key with an unknown name keeps its name, so
 * the option schema rejects it.
 */
export function flattenSettings(nested: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _schema, advanced, ...flat } = nested;
  if (advanced === undefined) return flat;
  if (!isRecord(advanced)) return { ...flat, advanced };
  const { prune, shake, ...options } = advanced;
  return {
    ...flat,
    ...options,
    ...prefixed("prune", prune),
    ...prefixed("shake", shake),
  };
}

/** `{ enabled }` under `prune` becomes `{ pruneEnabled }`; a value that is not an object is kept as it is. */
function prefixed(prefix: string, value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) return { [prefix]: value };
  return Object.fromEntries(
    Object.entries(value).map(([key, option]) => [
      prefix + key.charAt(0).toUpperCase() + key.slice(1),
      option,
    ]),
  );
}

/**
 * Converts the 0.3 `contextKit` block of Pi's settings into the content of `context-kit.json`
 * with the same behavior. An invalid threshold or method order is dropped, so its default applies,
 * as in 0.3. Other values are copied, so the usual checks report an invalid one.
 */
export function migrateLegacy(legacy: unknown): Record<string, unknown> {
  const old = isRecord(legacy) ? legacy : {};
  const result: Record<string, unknown> = {};
  if (typeof old.enabled === "boolean") result.enabled = old.enabled;
  result.threshold = threshold(old);
  const advanced = copyAdvanced(old);
  const { strategy, order, background } = methods(old);
  if (strategy && strategy !== "balanced") result.strategy = strategy;
  if (!strategy) advanced.methodOrder = order;
  if (writesHandoff(order) && background !== STRATEGIES[strategy ?? "balanced"].background)
    advanced.background = background;
  return withAdvanced(result, advanced);
}

/**
 * Converts the 0.3 project block, which Pi merged over the global block. It writes only what the
 * project block sets, with the values of the merged block, and overrides `globalFile` where that
 * changes the method order or background.
 */
export function migrateProject(
  globalLegacy: unknown,
  projectLegacy: unknown,
  globalFile: Record<string, unknown>,
): Record<string, unknown> {
  const project = isRecord(projectLegacy) ? projectLegacy : {};
  const merged = mergeSettings(isRecord(globalLegacy) ? globalLegacy : {}, project);
  const result: Record<string, unknown> = {};
  if (typeof project.enabled === "boolean") result.enabled = project.enabled;
  if ("thresholdTokens" in project || "thresholdPercent" in project)
    result.threshold = threshold(merged);
  const advanced = copyAdvanced(project);
  if ("methodOrder" in project || "asyncEnabled" in project) {
    const over = projectMethods(merged, globalFile);
    if (over.strategy) result.strategy = over.strategy;
    Object.assign(advanced, over.advanced);
  }
  return withAdvanced(result, advanced);
}

/** The method settings of the merged block, written so that they override `globalFile`. */
function projectMethods(
  merged: Record<string, unknown>,
  globalFile: Record<string, unknown>,
): { strategy?: Strategy; advanced: Record<string, unknown> } {
  const { strategy, order, background } = methods(merged);
  const globalAdvanced = isRecord(globalFile.advanced) ? globalFile.advanced : {};
  const advanced: Record<string, unknown> = {};
  // false avoids the "no effect" warning for a global background that this order does not use.
  if (writesHandoff(order) || "background" in globalAdvanced)
    advanced.background = writesHandoff(order) && background;
  if (strategy && !("methodOrder" in globalAdvanced)) return { strategy, advanced };
  return { advanced: { methodOrder: order, ...advanced } };
}

/** The strategy with the same method order, if any, and the background setting of 0.3. */
function methods(old: Record<string, unknown>): {
  strategy: Strategy | undefined;
  order: Method[];
  background: boolean;
} {
  const order = methodOrder(old.methodOrder);
  return {
    strategy: NAMES.find((name) => same(STRATEGIES[name].methodOrder, order)),
    order,
    background: typeof old.asyncEnabled === "boolean" ? old.asyncEnabled : true,
  };
}

function copyAdvanced(old: Record<string, unknown>): Record<string, unknown> {
  const advanced: Record<string, unknown> = {};
  for (const key of ADVANCED) if (key in old) advanced[key] = old[key];
  return advanced;
}

function withAdvanced(
  result: Record<string, unknown>,
  advanced: Record<string, unknown>,
): Record<string, unknown> {
  return Object.keys(advanced).length > 0 ? { ...result, advanced } : result;
}

/** 0.3 used `thresholdTokens` when both thresholds were set. */
function threshold(old: Record<string, unknown>): number | string {
  const tokens = old.thresholdTokens;
  if (Number.isSafeInteger(tokens) && Number(tokens) > 0) return Number(tokens);
  const percent = old.thresholdPercent;
  if (typeof percent === "number" && percent > 0 && percent <= 100) return `${percent}%`;
  return "pi";
}

/** 0.3 skipped "remote" and "snapcompact", which 0.4 rejects, and used the default for other values. */
function methodOrder(value: unknown): Method[] {
  const known = Array.isArray(value)
    ? value.filter((method) => method !== "remote" && method !== "snapcompact")
    : undefined;
  if (known?.every(isMethod)) return [...new Set(known)];
  return [...STRATEGIES.balanced.methodOrder];
}

function same(a: readonly Method[], b: readonly Method[]): boolean {
  return a.length === b.length && a.every((method, index) => method === b[index]);
}
