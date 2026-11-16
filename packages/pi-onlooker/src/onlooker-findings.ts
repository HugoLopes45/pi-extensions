import type { OnlookerFinding, OnlookerSeverity } from "./onlooker-contract.js";

export function normalized(message: string): string {
  return message
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(?<!\w)(\*\*|__|\*|_)(?=\S)(.+?)\1(?!\w)/g, "$2")
    .replace(/^\s*(?:#{1,6}|[-*+])\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const severityRank = { nit: 1, concern: 2, blocker: 3 } as const satisfies Record<
  OnlookerSeverity,
  number
>;

/** Keep report order while replacing same-message findings with their highest severity. */
export function selectFindings(
  findings: readonly OnlookerFinding[],
  limit: number,
): OnlookerFinding[] {
  const distinct = new Map<string, OnlookerFinding>();
  for (const finding of findings) {
    const key = normalized(finding.message);
    const previous = distinct.get(key);
    if (!previous || severityRank[finding.severity] > severityRank[previous.severity])
      distinct.set(key, finding);
  }
  const ordered = [...distinct.values()];
  if (ordered.length <= limit) return ordered;
  const selected = new Set(
    ordered
      .toSorted((left, right) => severityRank[right.severity] - severityRank[left.severity])
      .slice(0, limit),
  );
  return ordered.filter((finding) => selected.has(finding));
}

/**
 * Split reported findings by their evidence: each must cite a Tool-Call Reference or a quote.
 * Every cited reference and quote must occur in the evidence supplied to this Onlooker Session.
 */
export function checkEvidence(
  findings: readonly OnlookerFinding[],
  known: ReadonlyMap<string, string>,
  suppliedText: string,
) {
  const supported: OnlookerFinding[] = [];
  const unsupported: OnlookerFinding[] = [];
  for (const finding of findings) {
    const refs = (finding.evidence?.refs ?? []).map((ref) => ref.trim().replace(/^`(.*)`$/, "$1"));
    const quote = finding.evidence?.quote?.trim();
    if (
      (!refs.length && !quote) ||
      refs.some((ref) => !known.has(ref)) ||
      (quote && !suppliedText.includes(quote))
    ) {
      unsupported.push(finding);
      continue;
    }
    const evidence: NonNullable<OnlookerFinding["evidence"]> = {};
    if (refs.length) evidence.refs = refs;
    if (quote) evidence.quote = quote;
    supported.push({ severity: finding.severity, message: finding.message, evidence });
  }
  return { supported, unsupported };
}
