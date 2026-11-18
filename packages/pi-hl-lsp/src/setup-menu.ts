import type { SettingRow, SettingsMenuSpec, SettingsMenuView } from "pi-hl-utils/settings-menu";

import type { Candidate } from "./detect.js";
import type { Offer } from "./setup.js";

export type SetupChange = { id: string; value: string };
// Language to failure text; undefined marks a server that started and was saved.
export type SetupResults = ReadonlyMap<string, string | undefined>;
type SetupRow = SettingRow<SetupChange>;
type Found = Offer & { server: Candidate };

const CONSENT = "consent";

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function choiceRow(
  id: string,
  label: string,
  description: string,
  values: string[],
  own: string,
): SetupRow {
  return {
    kind: "cycle",
    id,
    label,
    description,
    values,
    own,
    inEffect: own,
    source: "session",
    change: (value) => ({ id, value }),
  };
}

function resultLine(language: string, error: string | undefined): string {
  return error === undefined ? `${language}: ready` : `${language}: failed: ${error} (not saved)`;
}

/**
 * The startup dialog: one enable/skip row per found server, a consent row when project execution
 * is not yet allowed, and an action that hands the choice to `enable`.
 */
export function setupSpec(
  offers: readonly Offer[],
  needsConsent: boolean,
  enable: (chosen: Offer[]) => Promise<SetupResults>,
): SettingsMenuSpec<SettingsMenuView, SetupChange> {
  const found = offers.filter((offer): offer is Found => offer.server !== undefined);
  const missing = offers.filter((offer) => !offer.server);
  const choices = new Map(found.map((offer) => [offer.language, "enable"]));
  let consent = "no";
  let started: Promise<void> | undefined;
  let results: SetupResults | undefined;
  const chosen = () => found.filter((offer) => choices.get(offer.language) === "enable");

  async function run(): Promise<void> {
    if (needsConsent && consent !== "yes" && chosen().length > 0)
      throw new Error("Set the consent row to yes: the servers run project code.");
    // A second Enable while servers start must not start or save them twice.
    started ??= enable(chosen()).then((value) => {
      results = value;
    });
    await started;
  }

  return {
    title: "Language servers for this project",
    read() {
      const headline = results
        ? [...results].map(([language, error]) => resultLine(language, error))
        : [
            `Found ${plural(offers.length, "language")}. Pick the servers to enable.`,
            ...missing.map(
              (offer) => `${offer.language}: not installed. Install: ${offer.install}`,
            ),
          ];
      return { headline, scopes: ["session"] };
    },
    rows() {
      if (results || found.length === 0) return [];
      const rows = found.map((offer) =>
        choiceRow(
          offer.language,
          offer.language,
          `${offer.server.command} for ${offer.fileTypes.join(" ")} files under ${offer.root}`,
          ["enable", "skip"],
          choices.get(offer.language) ?? "enable",
        ),
      );
      if (needsConsent)
        rows.push(
          choiceRow(
            CONSENT,
            "Allow project code",
            "These servers may run project code: build scripts, macros, plugins. Required to enable.",
            ["no", "yes"],
            consent,
          ),
        );
      const count = plural(chosen().length, "server");
      rows.push({
        kind: "action",
        id: "apply",
        label: "Enable",
        description: `Start and save ${count}; esc skips, /hl-lsp-setup reopens.`,
        value: count,
        run,
      });
      return rows;
    },
    async apply(_scope, change) {
      if (change.id === CONSENT) consent = change.value;
      else if (choices.has(change.id)) choices.set(change.id, change.value);
    },
  };
}
