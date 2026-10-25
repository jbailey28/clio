/**
 * Scores a search function against CASES. Used by the test suite and by
 * scripts/discovery-eval.ts, which prints the same numbers for a person.
 */
import type { Library } from "../../src/core";
import { CASES, type Case } from "./cases";

/** One result as the caller is shown it. */
export interface Hit {
  slug: string;
  capability?: string;
  /** strong: presented as a solution. partial: may solve part of it.
   * related: shown only as a weaker possibility, never as a solution. */
  strength: "strong" | "partial" | "related";
}

export type Searcher = (lib: Library, q: string) => Hit[];

/** The search the MCP find_reusable_functionality tool runs. Before this
 * milestone it had no notion of strength, so everything it returned was
 * presented to Claude as a match. */
export const viaFunctionality: Searcher = (lib, q) =>
  (lib.components.findFunctionality(q, 10) as any[]).map((m) => ({
    slug: m.component.slug,
    capability: m.capability?.name ?? m.matchedCapabilities?.[0],
    strength: m.strength ?? "strong",
  }));

/** The browser's search box. */
export const viaBrowser: Searcher = (lib, q) => {
  const ranked = (lib as any).discovery?.browse;
  if (ranked) return (ranked(q) as any[]).map((r) => ({ slug: r.component.slug, capability: r.capability?.name, strength: r.strength }));
  return lib.components.search(q).map((c) => ({ slug: c.slug, strength: "strong" as const }));
};

export interface CaseResult {
  c: Case;
  hits: Hit[];
  available: string[];
  retrieved: boolean | null;     // null: nothing to retrieve
  topCorrect: boolean | null;
  capCorrect: boolean | null;
  falsePositive: boolean | null; // null: the case has an answer
  wrongStrong: boolean;          // a notStrong component shown as the solution
  uncertain: boolean;
  relatedOnly: boolean;          // nothing presented, a weaker possibility shown
}

export interface Score {
  cases: number;
  relevantCases: number;
  retrieval: number;
  topCorrect: number;
  capCases: number;
  capCorrect: number;
  noAnswerCases: number;
  falsePositives: number;
  wrongStrong: number;
  uncertain: number;
  relatedOnly: number;
  details: CaseResult[];
}

const presented = (h: Hit) => h.strength !== "related";

export function evaluate(lib: Library, search: Searcher, cases: Case[] = CASES): Score {
  const present = new Set(lib.components.search("", { limit: 1000 }).map((c) => c.slug));
  const details: CaseResult[] = cases.map((c) => {
    const hits = search(lib, c.q);
    const shown = hits.filter(presented);
    const available = c.want.filter((s) => present.has(s));
    const top = shown[0];
    const has = available.length > 0;
    return {
      c,
      hits,
      available,
      retrieved: has ? shown.slice(0, 3).some((h) => available.includes(h.slug)) : null,
      topCorrect: has ? !!top && available.includes(top.slug) : null,
      capCorrect: has && c.cap && available.includes(c.want[0]) ? !!top && top.slug === c.want[0] && top.capability === c.cap : null,
      falsePositive: has ? null : shown.length > 0,
      wrongStrong: hits.some((h) => h.strength === "strong" && (c.notStrong ?? []).includes(h.slug)),
      uncertain: !!top && top.strength === "partial",
      relatedOnly: !top && hits.length > 0,
    };
  });
  const count = (f: (d: CaseResult) => boolean) => details.filter(f).length;
  return {
    cases: details.length,
    relevantCases: count((d) => d.retrieved !== null),
    retrieval: count((d) => d.retrieved === true),
    topCorrect: count((d) => d.topCorrect === true),
    capCases: count((d) => d.capCorrect !== null),
    capCorrect: count((d) => d.capCorrect === true),
    noAnswerCases: count((d) => d.falsePositive !== null),
    falsePositives: count((d) => d.falsePositive === true),
    wrongStrong: count((d) => d.wrongStrong),
    uncertain: count((d) => d.uncertain),
    relatedOnly: count((d) => d.relatedOnly),
    details,
  };
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "n/a");

export function summary(s: Score): string {
  return [
    `relevant retrieved (top 3)   ${s.retrieval}/${s.relevantCases}  ${pct(s.retrieval, s.relevantCases)}`,
    `correct top result           ${s.topCorrect}/${s.relevantCases}  ${pct(s.topCorrect, s.relevantCases)}`,
    `correct capability on top    ${s.capCorrect}/${s.capCases}  ${pct(s.capCorrect, s.capCases)}`,
    `false positives (no answer)  ${s.falsePositives}/${s.noAnswerCases}  ${pct(s.falsePositives, s.noAnswerCases)}`,
    `wrong thing shown as solution ${s.wrongStrong}`,
    `uncertain (partial on top)   ${s.uncertain}`,
    `only a related possibility   ${s.relatedOnly}`,
  ].join("\n");
}
