import { errorText } from "pi-hl-utils/errors";

import { detectLanguages, findServer, type Candidate } from "./detect.js";
import type { LspChange } from "./menu.js";
import { presetFor } from "./presets.js";
import { LanguageServer } from "./server.js";
import type { LspOptions } from "./settings.js";

// A detected language: the server found for it, or how to install one.
export type Offer = {
  language: string;
  root: string;
  server: Candidate | undefined;
  install: string;
  fileTypes: readonly string[];
};

export async function findOffers(
  cwd: string,
  known: ReadonlySet<string>,
  path: string | undefined,
): Promise<Offer[]> {
  const detected = [...(await detectLanguages(cwd))].filter(([language]) => !known.has(language));
  return Promise.all(
    detected.map(async ([language, root]) => {
      const preset = presetFor(language);
      if (!preset?.discovery) throw new Error(`Detected ${language} has no discovery preset`);
      return {
        language,
        root,
        server: await findServer(language, root, cwd, path),
        install: preset.discovery.install,
        fileTypes: preset.fileTypes,
      };
    }),
  );
}

// A present binary can still fail to start, so a server is saved only after its handshake.
export async function checkServer(
  server: Candidate,
  root: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const instance = new LanguageServer(server, root, timeoutMs, () => {});
  try {
    await instance.initialize(AbortSignal.timeout(timeoutMs));
  } catch (error) {
    // initialize() has already stopped the server.
    return errorText(error);
  }
  await instance.dispose();
  return undefined;
}

export function setupChanges(
  global: LspOptions,
  enabled: readonly Offer[],
  skipped: readonly string[],
  consent: boolean,
): LspChange[] {
  const changes: LspChange[] = [];
  const servers = { ...global.servers };
  for (const { language, server } of enabled)
    if (server) servers[language] = { command: server.command, args: server.args };
  if (enabled.some(({ server }) => server)) {
    changes.push(
      { action: "set", key: "servers", patch: { servers } },
      { action: "set", key: "enabled", patch: { enabled: true } },
    );
  }
  if (consent)
    changes.push({
      action: "set",
      key: "allowProjectExecution",
      patch: { allowProjectExecution: true },
    });
  if (skipped.length > 0) {
    const ignoredLanguages = [...new Set([...(global.ignoredLanguages ?? []), ...skipped])];
    changes.push({
      action: "set",
      key: "ignoredLanguages",
      patch: { ignoredLanguages },
    });
  }
  return changes;
}
