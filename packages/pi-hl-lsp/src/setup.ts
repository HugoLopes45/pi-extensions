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

export type FoundOffer = Offer & { server: Candidate };
// Language to failure text; undefined marks a server that completed its handshake.
export type SetupResults = ReadonlyMap<string, string | undefined>;

// A present binary can still fail to start, so a server is saved only after its handshake.
export async function checkOffers(
  chosen: readonly FoundOffer[],
  timeoutMs: number,
): Promise<SetupResults> {
  const errors = await Promise.all(
    chosen.map((offer) => checkServer(offer.server, offer.root, timeoutMs)),
  );
  return new Map<string, string | undefined>(
    chosen.map((offer, index) => [offer.language, errors[index]]),
  );
}

async function checkServer(
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

/**
 * The global settings changes after the dialog closes. Ready servers are saved; a failed one stays
 * offered so the next start shows it again; every other offered language is ignored.
 */
export function setupChanges(
  global: LspOptions,
  offers: readonly Offer[],
  results: SetupResults,
  grantsExecution: boolean,
): LspChange[] {
  const changes: LspChange[] = [];
  const servers = { ...global.servers };
  let saved = 0;
  for (const { language, server } of offers)
    if (server && results.has(language) && results.get(language) === undefined) {
      servers[language] = { command: server.command, args: server.args };
      saved++;
    }
  if (saved > 0)
    changes.push(
      { action: "set", key: "servers", patch: { servers } },
      { action: "set", key: "enabled", patch: { enabled: true } },
    );
  if (saved > 0 && grantsExecution)
    changes.push({
      action: "set",
      key: "allowProjectExecution",
      patch: { allowProjectExecution: true },
    });
  const ignored = ignoredChange(global.ignoredLanguages ?? [], offers, results);
  if (ignored) changes.push(ignored);
  return changes;
}

// A retried language leaves the ignored list, so a failed retry is offered again at the next start.
function ignoredChange(
  ignored: readonly string[],
  offers: readonly Offer[],
  results: SetupResults,
): LspChange | undefined {
  const skipped = offers
    .filter(({ language }) => !results.has(language))
    .map(({ language }) => language);
  const kept = ignored.filter((language) => !results.has(language));
  if (skipped.length === 0 && kept.length === ignored.length) return undefined;
  return {
    action: "set",
    key: "ignoredLanguages",
    patch: { ignoredLanguages: [...new Set([...kept, ...skipped])] },
  };
}
