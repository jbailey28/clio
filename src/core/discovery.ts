import type { DB } from "./db";
import { getComponent, searchComponents, type ComponentSummary } from "./components";
import { getProject } from "./projects";
import { latestRelease } from "./releases";
import { slugify } from "./util";
import { CONCEPTS, OBSERVING, type Concept } from "./vocabulary";

/**
 * Plain-language lookup: "I want to figure out what software a website uses".
 *
 * Local and explainable, no model and no index to keep in sync. Every call
 * reads the library as it is now and scores each capability of each
 * component on:
 *  - the literal words (stemmed),
 *  - concepts from vocabulary.ts, so synonyms and vendor names meet,
 *  - the job asked for: a component that detects email tools is related to,
 *    but not a solution for, "send a newsletter",
 *  - small misspellings, corrected against the library's own words.
 *
 * Each result says how strong it is (strong / partial / related), which
 * capability matched and why, and what in the request it did not cover.
 */

export type Strength = "strong" | "partial" | "related";

export interface MatchedCapability { name: string; description: string; kind: "capability" | "check" }

export interface FunctionalityMatch {
  component: ComponentSummary;
  score: number;
  /** strong: does what was asked. partial: covers part of it. related: same
   * subject, different job, or only loosely connected. Never a solution. */
  strength: Strength;
  /** One plain sentence for the strength. */
  fit: string;
  /** The capability that matched best, or null when the match is the
   * component as a whole. */
  capability: MatchedCapability | null;
  /** Other capabilities of the same component that also matched. */
  otherCapabilities: string[];
  why: string;
  /** Parts of the request this component did not match. */
  unmatched: string[];
  /** Query words that matched somewhere (kept for older callers). */
  matchedTerms: string[];
  /** Every capability that matched, best first (kept for older callers). */
  matchedCapabilities: string[];
}

export interface QueryReading {
  /** What the request was taken to be about. */
  topics: string[];
  /** The job asked for, when one was recognized. */
  jobs: string[];
  corrections: { from: string; to: string }[];
}

export interface Discovery {
  query: QueryReading;
  /** Best first: strong, then partial, then related. */
  results: FunctionalityMatch[];
}

// --- text ---------------------------------------------------------------

const STOP = new Set(
  ("a an and any are as at be but by can do does for from get has have how i if in into is it its me my need needs of on or our " +
    "should so some something that the their them then there these thing this to use used uses using want wants was way we what " +
    "when where which while who will with would you your component library code reusable reuse function functionality")
    .split(" "),
);

/** Crude stemmer: enough that "retries", "retrying" and "retry" meet. */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length >= 6 && /(ss|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  for (const suf of ["ations", "ation", "ings", "ing", "ies", "ied", "ers", "er", "ed", "ly", "s"]) {
    if (w.length - suf.length >= 3 && w.endsWith(suf) && !(suf === "s" && w.endsWith("ss"))) {
      w = w.slice(0, -suf.length);
      if (suf === "ies" || suf === "ied") w += "y";
      break;
    }
  }
  return w;
}

const tokens = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

export function terms(text: string): string[] {
  return [...new Set(tokens(text).filter((w) => w.length > 1 && !STOP.has(w)).map(stem))];
}

const stemSeq = (text: string) => ` ${tokens(text).map(stem).join(" ")} `;

interface Compiled { c: Concept; words: Set<string>; phrases: string[]; patterns: RegExp[] }
const COMPILED: Compiled[] = CONCEPTS.map((c) => ({
  c,
  words: new Set((c.words ?? []).map(stem)),
  phrases: (c.phrases ?? []).map((p) => stemSeq(p)),
  patterns: c.patterns ?? [],
}));
const KIND = new Map(CONCEPTS.map((c) => [c.key, c.kind]));
const LABEL = new Map(CONCEPTS.map((c) => [c.key, c.label]));

/** Concept key → the words in `text` that triggered it. */
function conceptsIn(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const seq = stemSeq(text);
  const raw = text.toLowerCase();
  const toks = tokens(text);
  for (const k of COMPILED) {
    const hits: string[] = [];
    for (const p of k.phrases) if (seq.includes(p)) hits.push(p.trim());
    for (const t of toks) if (k.words.has(stem(t))) hits.push(t);
    for (const re of k.patterns) { const m = raw.match(re); if (m) hits.push(m[0]); }
    if (hits.length) out.set(k.c.key, [...new Set(hits)]);
  }
  return out;
}

// --- misspellings --------------------------------------------------------

/** Damerau-Levenshtein, stopping early once past `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      best = Math.min(best, d[i][j]);
    }
    if (best > max) return max + 1;
  }
  return d[a.length][b.length];
}

/** Fixes a word only when it is unknown, at least six letters (shorter real
 * words sit one letter apart too often: login, logic), starts with
 * the same letter as the fix, and is one edit away (two from ten letters).
 * A different ending of the same word ("generate", "generated") is not a
 * misspelling, so it is left alone. */
const ENDINGS = new Set(["s", "es", "d", "ed", "ing", "er", "ers", "ly", "ion", "ions"]);
const sameWord = (a: string, b: string) => {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long.startsWith(short) && ENDINGS.has(long.slice(short.length));
};

function correct(text: string, vocab: Set<string>, stems: Set<string>) {
  const corrections: { from: string; to: string }[] = [];
  const fixed = text.replace(/[A-Za-z]+/g, (word) => {
    const w = word.toLowerCase();
    if (w.length < 6 || vocab.has(w) || stems.has(stem(w)) || STOP.has(w)) return word;
    const max = w.length >= 10 ? 2 : 1;
    let best = "", bestD = max + 1;
    for (const v of vocab) {
      if (v[0] !== w[0] || v.length < 4 || sameWord(w, v)) continue;
      const dd = distance(w, v, max);
      if (dd < bestD || (dd === bestD && v.length < best.length)) { best = v; bestD = dd; }
    }
    if (!best) return word;
    corrections.push({ from: w, to: best });
    return best;
  });
  return { fixed, corrections };
}

// --- the library, read for matching ---------------------------------------

interface Field { label: string; weight: number; concepts: Map<string, string[]>; stems: Set<string>; prefix?: string[] }

const field = (label: string, weight: number, text: string, prefix = false): Field => ({
  label, weight, concepts: conceptsIn(text), stems: new Set(terms(text)), prefix: prefix ? terms(text) : undefined,
});

interface Indexed {
  summary: ComponentSummary;
  nameStems: string[];
  fields: Field[];
  actions: Set<string>;
  capabilities: { cap: MatchedCapability; nameStems: string[]; fields: Field[] }[];
}

function readLibrary(db: DB, categorySlug?: string): { items: Indexed[]; vocab: Set<string>; stems: Set<string> } {
  const all = searchComponents(db, "", { limit: 1000, category: categorySlug });
  const caps = db.prepare("SELECT component_id AS cid, name, description, kind FROM capabilities ORDER BY position").all() as
    { cid: string; name: string; description: string; kind: "capability" | "check" }[];
  const extra = new Map((db.prepare(
    "SELECT c.id, c.documentation, k.description AS catDesc FROM components c JOIN categories k ON k.id = c.category_id",
  ).all() as { id: string; documentation: string; catDesc: string }[]).map((r) => [r.id, r]));
  const io = db.prepare("SELECT component_id AS cid, name, type, description FROM component_io").all() as
    { cid: string; name: string; type: string; description: string }[];

  const vocab = new Set<string>();
  const stems = new Set<string>();
  const learn = (text: string) => { for (const t of tokens(text)) { vocab.add(t); stems.add(stem(t)); } };
  for (const c of CONCEPTS) for (const w of [...(c.words ?? []), ...(c.phrases ?? [])]) learn(w);

  const items = all.map((c) => {
    const myCaps = caps.filter((x) => x.cid === c.id);
    const myIO = io.filter((x) => x.cid === c.id).map((x) => `${x.name} ${x.type} ${x.description}`).join(" ");
    const ex = extra.get(c.id);
    const name = `${c.name} ${c.slug.replace(/-/g, " ")}`;
    for (const t of [name, c.summary, c.categoryName, ex?.catDesc ?? "", myIO, ex?.documentation ?? "", ...myCaps.map((x) => `${x.name} ${x.description}`)]) learn(t);
    return {
      summary: c,
      nameStems: terms(c.name),
      fields: [
        field("name", 4, name, true),
        field("summary", 3, c.summary),
        field("category", 2, `${c.categoryName} ${ex?.catDesc ?? ""}`),
        field("inputs and outputs", 2, myIO),
        field("documentation", 0.5, ex?.documentation ?? ""),
      ],
      // The jobs a component does come from what it says it is, not from its
      // long documentation, which mentions everything it is not.
      actions: new Set([...conceptsIn([c.name, c.summary, ...myCaps.map((x) => x.name)].join(". ")).keys()].filter((k) => KIND.get(k) === "action")),
      capabilities: myCaps.map((x) => ({
        cap: { name: x.name, description: x.description, kind: x.kind },
        nameStems: terms(x.name),
        fields: [field("capability name", 4, x.name), field("capability description", 3, x.description)],
      })),
    };
  });
  return { items, vocab, stems };
}

// --- the request ----------------------------------------------------------

interface Feature { key: string; kind: "topic" | "generic" | "term"; weight: number; said: string }

function readQuery(q: string, vocab: Set<string>, stems: Set<string>) {
  const { fixed, corrections } = correct(q, vocab, stems);
  const found = conceptsIn(fixed);
  const covered = new Set<string>();
  for (const [key, hits] of found) {
    for (const h of hits) {
      const ws = tokens(h);
      // A pattern can span half a sentence; only its ends are "used up".
      const use = (KIND.get(key) === "action" && ws.length > 3) ? [ws[0], ws[ws.length - 1]!] : ws;
      for (const w of use) if (w) covered.add(stem(w));
    }
  }
  const features: Feature[] = [];
  const actions = new Set<string>();
  for (const [key, hits] of found) {
    const kind = KIND.get(key)!;
    if (kind === "action") actions.add(key);
    else features.push({ key, kind, weight: kind === "topic" ? 3 : 0.5, said: hits[0]! });
  }
  for (const t of terms(fixed)) if (!covered.has(t)) features.push({ key: t, kind: "term", weight: 1.5, said: t });
  const stemsSaid = new Set(terms(fixed));
  return { fixed, corrections, features, actions, stemsSaid };
}

// --- scoring --------------------------------------------------------------

const has = (f: Field, feat: Feature) =>
  feat.kind === "term"
    ? f.stems.has(feat.key)
      || (feat.key.length >= 3 && !!f.prefix?.some((p) => p.startsWith(feat.key)))
      || (feat.key.length >= 4 && [...f.stems].some((s) => s.length <= feat.key.length + 5 && s.startsWith(feat.key)))
    : f.concepts.has(feat.key);

const SPECIFIC = ["detect", "send", "analyze_text"];

function conflictOf(asked: Set<string>, does: Set<string>): boolean {
  if (!does.size) return false;
  const specific = [...asked].filter((a) => SPECIFIC.includes(a));
  if (specific.length && !specific.some((a) => does.has(a))) return true;
  // Asked to build or run the thing; this only looks at other people's.
  return asked.has("provide") && !asked.has("detect") && [...does].every((a) => OBSERVING.has(a));
}

const RANK: Record<Strength, number> = { strong: 0, partial: 1, related: 2 };

export function discover(db: DB, description: string, opts: { limit?: number; category?: string } = {}): Discovery {
  const { items, vocab, stems } = readLibrary(db, opts.category);
  const q = readQuery(description, vocab, stems);
  const query: QueryReading = {
    topics: q.features.filter((f) => f.kind === "topic").map((f) => LABEL.get(f.key)!),
    jobs: [...q.actions].map((a) => LABEL.get(a)!),
    corrections: q.corrections,
  };
  if (!q.features.length) return { query, results: [] };
  const total = q.features.reduce((s, f) => s + f.weight, 0);

  const results: FunctionalityMatch[] = [];
  for (const item of items) {
    const nameMatch = item.nameStems.length > 0 && item.nameStems.every((s) => q.stemsSaid.has(s));
    const units = [null, ...item.capabilities].map((cap) => {
      const fields = [...(cap?.fields ?? []), ...item.fields];
      let score = 0, matchedW = 0, fromCap = false;
      let topicStrong = false, topicAny = false, termStrong = false;
      const matched: Feature[] = [], missed: Feature[] = [], where = new Map<Feature, string>();
      for (const feat of q.features) {
        const hit = fields.filter((f) => has(f, feat)).sort((a, b) => b.weight - a.weight)[0];
        if (!hit) { missed.push(feat); continue; }
        matched.push(feat); where.set(feat, hit.label);
        score += feat.weight * hit.weight / 5;
        matchedW += feat.weight;
        if (cap && cap.fields.includes(hit) && feat.kind !== "generic") fromCap = true;
        if (feat.kind === "topic") { topicAny = true; if (hit.weight >= 3) topicStrong = true; }
        if (feat.kind === "term" && hit.weight >= 3) termStrong = true;
      }
      // The request's own words, wherever a concept already covered them:
      // two components can share a concept, and the one that also uses the
      // request's words is the closer fit.
      for (const s of q.stemsSaid) {
        const w = Math.max(0, ...fields.filter((f) => f.stems.has(s)).map((f) => f.weight));
        score += w / 4;
      }
      const capNameMatch = !!cap && cap.nameStems.length > 0 && cap.nameStems.every((s) => q.stemsSaid.has(s));
      if (capNameMatch) score += 5;
      if (nameMatch) score += 5;
      return { cap, score, coverage: matchedW / total, fromCap, topicStrong, topicAny, termStrong, capNameMatch, matched, missed, where };
    });

    const whole = units[0];
    const capUnits = units.slice(1).filter((u) => u.fromCap || u.capNameMatch);
    // Name a capability only when it explains the match better than the
    // component as a whole does.
    const best = capUnits.sort((a, b) => Number(b.capNameMatch) - Number(a.capNameMatch) || b.score - a.score)[0];
    const pick = best && (best.capNameMatch || best.score > whole.score) ? best : whole;
    if (!(pick.topicAny || pick.termStrong || nameMatch || pick.capNameMatch)) continue;

    const conflict = conflictOf(q.actions, item.actions);
    let strength: Strength;
    if (conflict) strength = "related";
    else if (nameMatch || pick.capNameMatch) strength = "strong";
    else if (pick.topicStrong && pick.coverage >= 0.5) strength = "strong";
    else if (pick.topicStrong || (pick.termStrong && pick.coverage >= 0.5)) strength = "partial";
    else strength = "related";

    const said = (fs: Feature[]) => fs.map((f) => (f.kind === "topic" ? `${LABEL.get(f.key)} (“${f.said}”)` : `“${f.said}”`));
    const topicLabels = pick.matched.filter((f) => f.kind === "topic").map((f) => LABEL.get(f.key)!);
    const does = [...item.actions].map((a) => LABEL.get(a)!);
    const capText = pick.cap ? `“${pick.cap.cap.name}”${pick.cap.cap.description ? `: ${pick.cap.cap.description}` : ""}. ` : "";
    let why: string;
    if (conflict) {
      why = `Same subject${topicLabels.length ? ` (${topicLabels.join(", ")})` : ""}, different job: ${item.summary.name} does ${does.join(", ") || "something else"}; ` +
        `the request is about ${query.jobs.join(", ")}. ${capText}`.trim();
    } else if (nameMatch || pick.capNameMatch) {
      why = `${capText}Named in the request.`;
    } else {
      why = `${capText}Matched on ${said(pick.matched.filter((f) => f.kind !== "generic")).join(", ") || said(pick.matched).join(", ")}.`;
    }
    const unmatched = pick.missed.filter((f) => f.kind !== "generic").map((f) => (f.kind === "topic" ? LABEL.get(f.key)! : f.said));
    const fit = strength === "strong"
      ? "Does what was asked."
      : strength === "partial"
        ? `Covers part of the request${unmatched.length ? `; nothing here for ${unmatched.map((u) => `“${u}”`).join(", ")}` : ""}.`
        : conflict
          ? "Related, but does a different job. Not a solution as it stands; possibly a starting point to extend."
          : "Only loosely related. Not a solution.";

    const ranked = capUnits.filter((u) => u.cap).map((u) => u.cap!.cap.name);
    results.push({
      component: item.summary,
      score: Math.round(pick.score * 100) / 100,
      strength,
      fit,
      capability: pick.cap ? pick.cap.cap : null,
      otherCapabilities: ranked.filter((n) => n !== pick.cap?.cap.name),
      why,
      unmatched,
      // Stems, as before this field had company.
      matchedTerms: [...new Set(pick.matched.flatMap((f) => (f.kind === "term" ? [f.key] : terms(f.said))))],
      matchedCapabilities: ranked,
    });
  }
  results.sort((a, b) => RANK[a.strength] - RANK[b.strength] || b.score - a.score);
  return { query, results: results.slice(0, Math.min(opts.limit ?? 10, 50)) };
}

/** Same as `discover`, as a flat list (the shape older callers expect). */
export function findFunctionality(db: DB, description: string, limit = 10): FunctionalityMatch[] {
  return discover(db, description, { limit }).results;
}

// --- what a caller needs to act on a match ----------------------------------

export interface MatchContext {
  version: string;
  latestRelease: { version: string; path: string } | null;
  /** Set when a project was given: whether it already uses this component. */
  usedByProject: { project: string; version: string } | null | undefined;
  /** Set when a project was given: whether this component's code was captured from it (origin, not use). */
  capturedFromProject: boolean | undefined;
  inspect: { getComponent: string; documentationChars: number; sources: string[] };
}

export function contextFor(db: DB, m: FunctionalityMatch, projectRef?: string): MatchContext {
  const detail = getComponent(db, m.component.id);
  const rel = latestRelease(db, m.component.id);
  let usedByProject: MatchContext["usedByProject"];
  let capturedFromProject: boolean | undefined;
  if (projectRef) {
    const p = getProject(db, projectRef);
    const link = p.components.find((l) => l.componentId === m.component.id);
    usedByProject = link ? { project: p.name, version: link.version } : null;
    capturedFromProject = detail.origin?.project?.id === p.id;
  }
  return {
    version: detail.version,
    latestRelease: rel ? { version: rel.version, path: rel.sourcePath } : null,
    usedByProject,
    capturedFromProject,
    inspect: { getComponent: detail.slug, documentationChars: detail.documentation.length, sources: detail.sources.map((s) => s.path) },
  };
}

// --- before building something new ------------------------------------------

export type DuplicateVerdict = "exact" | "partial" | "related" | "none";

export interface DuplicateReport {
  /** Same slug or same name: registering would be refused or confusing. */
  exact: ComponentSummary[];
  /** Overlapping functionality, strongest first. A hint to inspect, not proof. */
  similar: FunctionalityMatch[];
  /** exact: a capability already does this. partial: something covers part
   * of it. related: same subject, different job (could be extended). none. */
  verdict: DuplicateVerdict;
  advice: string;
}

export function findDuplicates(db: DB, input: { name: string; summary?: string; capabilities?: string[] }): DuplicateReport {
  const slug = slugify(input.name);
  const exact = searchComponents(db, "", { limit: 1000 }).filter(
    (c) => c.slug === slug || c.name.toLowerCase() === input.name.trim().toLowerCase(),
  );
  const similar = findFunctionality(db, [input.name, input.summary ?? "", ...(input.capabilities ?? [])].join(". "), 5).filter(
    (m) => !exact.some((e) => e.id === m.component.id),
  );
  const top = similar[0]?.strength;
  const verdict: DuplicateVerdict = exact.length || top === "strong" ? "exact" : top === "partial" ? "partial" : top === "related" ? "related" : "none";
  const advice = {
    exact: exact.length
      ? "A component with this name already exists. Update it instead of adding another."
      : `${similar[0]?.component.name} already does this. Read it with get_component and reuse it unless it truly does not fit.`,
    partial: `${similar[0]?.component.name} covers part of this. Read it first: extending it, or building only the missing part, may be better than starting over.`,
    related: `${similar[0]?.component.name} works on the same subject but does a different job. It does not prevent building this; it may be worth reading first.`,
    none: "Nothing in the library does this. Building it new is reasonable.",
  }[verdict];
  return { exact, similar, verdict, advice };
}
