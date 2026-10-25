import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db";
import { LibraryError, invalid } from "./errors";
import { activeStep, draftStore, type DraftBase, type Report } from "./drafts";
import { ask } from "./generator";
import { inspectAll, type ReleaseInspection } from "./inspect";
import { discover } from "./discovery";
import { componentPathsFile, listComponentsWithReleases, matchTestFile, writeComponentCopy } from "./integration";
import { excludedReason, findSecrets } from "./packaging";
import { checkPath } from "./paths";
import { linkComponent, listProjects, registerProject, setIntegration } from "./projects";
import { treeChecksum, verifyRelease } from "./releases";
import { PYTHON, componentCalls, sandboxedTraceCommand, standardLibrary } from "./sandbox";
import { getSettings, iCloudWarning, insideReal } from "./settings";
import { runShell, type ShellResult } from "./testing";
import { newId, now, slugify } from "./util";

/**
 * "Create project", in five steps: Describe → Plan → Components → Build → Test.
 *
 * Plan: the AI proposes an editable plan (name, description, what it will do,
 * technology, a checklist of features). The person edits it, or asks the AI to
 * change it; a refinement is applied as specific changes, so unrelated edits
 * stay, and it can be undone.
 *
 * Components: from the plan as it stands, every component's release is
 * inspected (its real functions, imports, network and file use) and the AI
 * maps each need to a component in the library, the project itself, or setup
 * the person does. The person chooses which components and optional needs to
 * keep; leaving out a component never drops the need: it is built instead.
 *
 * Build and Test: as before. The tested build is copied into a new folder,
 * checked, and then the project and its links are recorded in one
 * transaction; any failure removes the folder and records nothing.
 *
 * Every later step records a fingerprint of exactly the inputs it was made
 * from. Moving between steps redoes nothing; a step is "out of date" (and
 * blocked) only when its inputs change, and becomes current again if they are
 * changed back (for example by Undo).
 */

// ---------- shapes ----------

export interface Feature {
  id: string;
  text: string;
  /** "asked": in their description. "suggested": the AI's idea. "you": added by the person. */
  origin: "asked" | "suggested" | "you";
  included: boolean;
  /** The person changed its wording. */
  edited: boolean;
}

export interface ProjectPlan {
  name: string;
  description: string;
  summary: string;
  technology: string;
  /** The description was open-ended, so this plan is a suggestion. */
  openEnded: boolean;
  features: Feature[];
}

export interface PlannedComponent {
  slug: string;
  name: string;
  version: string;
  packages: string[];
  contributes: string;
  uses: string[];
  fit: "full" | "partial";
  missing: string;
  evidence: { functions: { name: string; signature: string; doc: string }[]; imports: string[]; network: boolean; readsFiles: boolean; testStatus: string | null; release: string };
  problems: string[];
}

export interface Need {
  id: string;
  need: string;
  featureIds: string[];
  status: "available" | "partial" | "build" | "setup";
  /** Core to the project: it can't be left out here, only by changing the plan. */
  required: boolean;
  component: string | null;
  why: string;
  limits: string;
  /** For a component: what is built in the project instead if it's left out. */
  ifLeftOut: string;
  /** For setup: what the person does. */
  steps: string;
}

export interface ComponentAnalysis {
  /** Fingerprint of the plan inputs this was made from. */
  key: string;
  language: "python" | "other";
  needs: Need[];
  components: PlannedComponent[];
  connections: string[];
  compatibility: string[];
  files: { path: string; purpose: string }[];
  nextSteps: string[];
}

export interface ProjectDraft extends DraftBase {
  prompt: string;
  plan: ProjectPlan | null;
  /** Plans before each AI refinement, newest last, for Undo. */
  undo: { plan: ProjectPlan; instruction: string; at: string }[];
  /** Goes up whenever the plan is replaced (a new plan, an AI change, Undo), so an open editor knows to reload. */
  planRevision?: number;
  /** What the last refinement changed, in plain words. */
  refined: { instruction: string; changes: string[]; at: string } | null;
  analysis: ComponentAnalysis | null;
  choice: { folder: string; useComponent: Record<string, boolean>; includeNeed: Record<string, boolean> };
  build: {
    key: string;
    attempt: number;
    at: string;
    feedback: string;
    files: { path: string; bytes: number; owner: "project" | "library" | "component" }[];
    problems: string[];
    notes: string[];
    usage: Record<string, { imported: boolean; called: string[] }>;
  } | null;
  tests: (ShellResult & { at: string; durationMs: number; checksum: string; calls: Record<string, string[]> }) | null;
  project: { id: string; path: string } | null;
  /** Made before the five-step flow; can't be continued. */
  legacy?: boolean;
}

const drafts = draftStore<ProjectDraft>("pdr", "Project draft");
export const discardProjectDraft = drafts.discard;
export const ownsProjectDraft = drafts.owns;

/** Reads a draft; drafts made before the five-step flow are flagged rather than guessed at. */
export function getProjectDraft(id: string): ProjectDraft {
  const d = drafts.get(id) as ProjectDraft & { proposal?: unknown };
  if (d.plan === undefined) return { ...d, plan: null, undo: [], refined: null, analysis: null, choice: { folder: "", useComponent: {}, includeNeed: {} }, build: null, tests: null, legacy: true };
  return d;
}
/** Unfinished project drafts, newest first. */
export const listProjectDrafts = () => drafts.list().filter((d) => !d.project).map((d) => getProjectDraft(d.id));

const FOLDER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ALLOWED_EXT = /\.(md|txt|py|js|mjs|cjs|ts|tsx|jsx|json|html|css|toml|ya?ml|cfg|ini|svg|csv)$/i;
const ALLOWED_DOTFILES = new Set([".gitignore", ".editorconfig"]);
const RESERVED = new Set(["component_paths.py", "tests/test_components_match_release.py"]);
const MAX_FILES = 30;
const MAX_BYTES = 100 * 1024;
const INSPECT_ALL_BELOW = 30;
const MAX_FEATURES = 20;
const UNDO_DEPTH = 10;

const LEGACY = "This plan was made with an earlier version. Start a new one.";
/** Direct edits refuse while a step runs, so neither overwrites the other. */
function editable(d: ProjectDraft) {
  if (d.legacy || d.plan === undefined) throw invalid(LEGACY);
  if (d.project) throw invalid("This project has already been created.");
  const running = activeStep(d);
  if (running) throw new LibraryError("CONFLICT", "Wait for the current step to finish, then try again.");
}
/** For steps: the draft read inside the step is the raw file. */
function current(d: ProjectDraft) {
  if (d.plan === undefined) throw invalid(LEGACY);
  if (d.project) throw invalid("This project has already been created.");
}

const buildDir = (d: ProjectDraft) => path.join(drafts.dir(d.id), "build", d.choice.folder || "project");
const buildChecksum = (d: ProjectDraft) => (fs.existsSync(buildDir(d)) ? treeChecksum(buildDir(d)).checksum : "");
const sha = (v: unknown) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

export function projectsRoot(db: DB) {
  const root = getSettings(db).projectsRoot;
  const allowed = getSettings(db).allowedRoots.some((r) => insideReal(root, r));
  return { path: root, exists: fs.existsSync(root), allowed, iCloud: iCloudWarning(root) };
}

const walk = (dir: string, base = dir): string[] => fs.readdirSync(dir).sort().flatMap((n) => {
  const f = path.join(dir, n);
  return fs.statSync(f).isDirectory() ? walk(f, base) : [path.relative(base, f)];
});

// ---------- fingerprints: what each step was made from ----------

/** The inputs the component analysis depends on: what the project must do, and its technology. */
export const componentsKey = (p: ProjectPlan) => sha({ f: p.features.filter((x) => x.included).map((x) => [x.id, x.text]), t: p.technology, s: p.summary });

/** Needs kept, and components used, given the person's choices. Leaving a component out keeps its need (built instead). */
export function decisions(d: ProjectDraft) {
  const a = d.analysis;
  if (!a) return { needs: [] as (Need & { included: boolean; using: string | null })[], components: [] as PlannedComponent[] };
  const usable = new Map(a.components.filter((c) => !c.problems.length).map((c) => [c.slug, c]));
  const needs = a.needs.map((n) => {
    const included = n.required || d.choice.includeNeed[n.id] !== false;
    const using = included && n.component && usable.has(n.component) && d.choice.useComponent[n.component] !== false ? n.component : null;
    return { ...n, included, using };
  });
  const used = new Set(needs.map((n) => n.using).filter(Boolean) as string[]);
  return { needs, components: a.components.filter((c) => used.has(c.slug)) };
}
export const includedComponents = (d: ProjectDraft) => decisions(d).components;

/** The inputs the build depends on: the plan, the analysis, the choices, the folder. */
export function buildKey(d: ProjectDraft) {
  if (!d.plan || !d.analysis) return "";
  const dec = decisions(d);
  return sha({ plan: [d.plan.name, d.plan.description, componentsKey(d.plan)], analysis: d.analysis.key, needs: dec.needs.map((n) => [n.id, n.included, n.using]), folder: d.choice.folder });
}

export type StepName = "describe" | "plan" | "components" | "build" | "test";
/** Where each later step stands: missing, current, or out of date because its inputs changed. */
export function freshness(d: ProjectDraft) {
  const components = !d.analysis ? "missing" : d.plan && d.analysis.key === componentsKey(d.plan) ? "current" : "outdated";
  const build = !d.build ? "missing" : components === "current" && d.build.key === buildKey(d) ? "current" : "outdated";
  const tests = !d.tests ? "missing" : build === "current" && d.tests.checksum === buildChecksum(d) ? "current" : "outdated";
  return { components, build, tests } as const;
}

// ---------- 1–2. describe and plan ----------

const FEATURE_ITEM = { type: "object", additionalProperties: false, required: ["text", "origin"], properties: {
  text: { type: "string", description: "One short plain sentence starting with a verb, e.g. 'Read your weekly Instagram export'." },
  origin: { type: "string", enum: ["asked", "suggested"], description: "asked: the description says so. suggested: your own idea." } } };

const PLAN_SCHEMA = {
  type: "object", additionalProperties: false, required: ["name", "description", "summary", "technology", "openEnded", "features"],
  properties: {
    name: { type: "string", description: "Short Title Case project name, 1 to 4 words." },
    description: { type: "string", description: "One plain sentence." },
    summary: { type: "string", description: "Two or three plain sentences: what the project does for them." },
    technology: { type: "string", description: "In plain words, e.g. 'A Python tool that writes a web page' or 'A small web application'." },
    openEnded: { type: "boolean", description: "True when the description is too open or vague to say what they want, so this is a suggestion." },
    features: { type: "array", items: FEATURE_ITEM, description: "3 to 8 features, in plain words. Mark only what the description really says as 'asked'." },
  },
};

const planPrompt = (text: string) => `Plan a new, small local software project for someone who does not code. Don't write code yet.

Their description:
"""${text}"""

Write a short plan: a name, one-sentence description, a two-or-three-sentence summary, the technology in plain words, and a checklist of features.
- Mark a feature "asked" only if the description really says it. Anything you add is "suggested".
- If the description is vague, experimental or doesn't say what to build, don't refuse: propose a small, useful starter project, set openEnded to true, and mark every feature "suggested".
- Prefer things that run on a Mac with nothing to install (Python's standard library, or plain HTML/CSS/JavaScript).
Use plain, non-technical words.`;

function toPlan(raw: any, ids?: () => string): ProjectPlan {
  if (!raw || typeof raw.name !== "string" || !raw.name.trim()) throw new LibraryError("GENERATION_FAILED", "The AI's plan was incomplete. Try again, or describe the project differently.");
  const next = ids ?? (() => newId("f"));
  const features = (Array.isArray(raw.features) ? raw.features : []).slice(0, MAX_FEATURES)
    .map((f: any) => ({ id: next(), text: String(f?.text ?? "").trim().slice(0, 200), origin: f?.origin === "asked" ? "asked" : "suggested", included: true, edited: false }) as Feature)
    .filter((f: Feature) => f.text);
  const openEnded = !!raw.openEnded;
  return {
    name: raw.name.trim().slice(0, 80), description: String(raw.description ?? "").trim().slice(0, 300), summary: String(raw.summary ?? "").trim().slice(0, 1000),
    technology: String(raw.technology ?? "").trim().slice(0, 200), openEnded,
    features: openEnded ? features.map((f: Feature) => ({ ...f, origin: "suggested" as const })) : features,
  };
}

function freshDraft(text: string): ProjectDraft {
  const t = text.trim();
  if (t.length < 10) throw invalid("Describe the project in a sentence or two, so there is something to plan from.");
  if (t.length > 4000) throw invalid("That description is very long. Keep it under 4,000 characters.");
  return { id: newId("pdr"), createdAt: now(), updatedAt: now(), prompt: t, plan: null, undo: [], refined: null, analysis: null,
    choice: { folder: "", useComponent: {}, includeNeed: {} }, build: null, tests: null, project: null, busy: null, lastError: null };
}

export function startProjectDraft(_db: DB, text: string) {
  const d = drafts.save(freshDraft(text));
  return planFromDescription(d.id).catch(() => {}).then(() => getProjectDraft(d.id)); // a failure is kept on the draft and shown there
}

/** Writes (or rewrites) the plan from the description. A rewrite keeps the old plan in Undo. */
export function planFromDescription(id: string, newText?: string) {
  return drafts.step(id, "plan", async (d, report: Report) => {
    current(d);
    if (newText !== undefined) { const t = freshDraft(newText).prompt; d.prompt = t; }
    report("Writing the plan…");
    const plan = toPlan(await ask("propose", planPrompt(d.prompt), PLAN_SCHEMA));
    if (d.plan) pushUndo(d, "It wrote a new plan from your changed description.");
    d.plan = plan;
    d.planRevision = (d.planRevision ?? 0) + 1;
    d.refined = null;
    if (!d.choice.folder) d.choice.folder = folderFor(plan.name);
  });
}

const folderFor = (name: string) => { const f = slugify(name).slice(0, 64); return FOLDER.test(f) ? f : "my-project"; };

function pushUndo(d: ProjectDraft, instruction: string) {
  d.undo = [...d.undo, { plan: structuredClone(d.plan!), instruction, at: now() }].slice(-UNDO_DEPTH);
}

/** The person's own edits: name, description, technology, and the checklist (wording, include, add, remove). */
export function savePlan(id: string, edit: { name: string; description: string; technology?: string; features: { id?: string; text: string; included: boolean }[] }) {
  const d = getProjectDraft(id);
  editable(d);
  if (!d.plan) throw invalid("There is no plan yet.");
  if (!edit.name.trim()) throw invalid("The project needs a name.");
  const byId = new Map(d.plan.features.map((f) => [f.id, f]));
  const features: Feature[] = [];
  for (const f of edit.features.slice(0, MAX_FEATURES)) {
    const text = f.text.trim().slice(0, 200);
    if (!text) continue;
    const old = f.id ? byId.get(f.id) : undefined;
    features.push(old ? { ...old, text, included: !!f.included, edited: old.edited || text !== old.text } : { id: newId("f"), text, origin: "you", included: !!f.included, edited: false });
  }
  if (!features.some((f) => f.included)) throw invalid("Keep at least one feature, so there is something to build.");
  d.plan = { ...d.plan, name: edit.name.trim().slice(0, 80), description: edit.description.trim().slice(0, 300),
    technology: edit.technology !== undefined ? edit.technology.trim().slice(0, 200) : d.plan.technology, features };
  if (!d.choice.folder) d.choice.folder = folderFor(d.plan.name);
  return drafts.save(d);
}

// ---------- refining with AI, and Undo ----------

const REFINE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["note", "name", "description", "summary", "technology", "add", "update", "remove"],
  properties: {
    note: { type: "string", description: "One plain sentence: what you changed." },
    name: { type: ["string", "null"], description: "New name only if the instruction asks for it, else null." },
    description: { type: ["string", "null"] }, summary: { type: ["string", "null"] }, technology: { type: ["string", "null"] },
    add: { type: "array", items: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } } },
    update: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "text"], properties: { id: { type: "string" }, text: { type: "string" } } } },
    remove: { type: "array", items: { type: "string" }, description: "Ids of features the instruction asks to remove." },
  },
};

const refinePrompt = (p: ProjectPlan, instruction: string) => `Change a project plan the way the person asks. Change only what the instruction needs; everything else must stay exactly as it is.

Current plan:
Name: ${p.name}
Description: ${p.description}
Summary: ${p.summary}
Technology: ${p.technology}
Features (id: text${" "}[who wrote it]):
${p.features.map((f) => `${f.id}: ${f.text} [${f.origin === "you" ? "added by the person" : f.edited ? "edited by the person" : f.origin}${f.included ? "" : ", left out"}]`).join("\n")}

Their instruction:
"""${instruction}"""

Return only the changes: new values for name, description, summary or technology (null to keep), features to add, features to reword (by id), and features to remove (by id). Never reword or remove a feature the person added or edited unless the instruction is clearly about it. Use plain words.`;

/** Applies the AI's changes to the current plan; anything it didn't name stays exactly as it was. Keeps the old plan for Undo. */
export function refinePlan(id: string, instruction: string) {
  return drafts.step(id, "refine", async (d, report: Report) => {
    current(d);
    if (!d.plan) throw invalid("There is no plan yet.");
    const text = instruction.trim();
    if (text.length < 3) throw invalid("Say what to change, for example “make it a web application instead”.");
    report("Changing the plan…");
    const ops = await ask<any>("propose", refinePrompt(d.plan, text), REFINE_SCHEMA);
    const p = structuredClone(d.plan);
    const changes: string[] = [];
    const set = (k: "name" | "description" | "summary" | "technology", label: string) => {
      const v = typeof ops?.[k] === "string" ? ops[k].trim() : "";
      if (v && v !== p[k]) { p[k] = v.slice(0, k === "summary" ? 1000 : 300); changes.push(`${label} changed`); }
    };
    set("name", "Name"); set("description", "Description"); set("summary", "Summary"); set("technology", "Technology");
    const ids = new Set(p.features.map((f) => f.id));
    for (const u of Array.isArray(ops?.update) ? ops.update : []) {
      const f = p.features.find((x) => x.id === u?.id);
      const t = String(u?.text ?? "").trim().slice(0, 200);
      if (f && t && t !== f.text) { changes.push(`Reworded “${f.text}”`); f.text = t; }
    }
    const remove = new Set((Array.isArray(ops?.remove) ? ops.remove : []).map(String).filter((x: string) => ids.has(x)));
    for (const f of p.features) if (remove.has(f.id)) changes.push(`Removed “${f.text}”`);
    p.features = p.features.filter((f) => !remove.has(f.id));
    for (const a of Array.isArray(ops?.add) ? ops.add : []) {
      const t = String(a?.text ?? "").trim().slice(0, 200);
      if (t && p.features.length < MAX_FEATURES && !p.features.some((f) => f.text.toLowerCase() === t.toLowerCase())) {
        p.features.push({ id: newId("f"), text: t, origin: "suggested", included: true, edited: false });
        changes.push(`Added “${t}”`);
      }
    }
    if (!changes.length) throw new LibraryError("GENERATION_FAILED", `The AI didn't change anything for “${text}”. Try saying it another way.`);
    if (!p.features.some((f) => f.included)) throw new LibraryError("GENERATION_FAILED", "That change would leave no features. Nothing was changed.");
    pushUndo(d, `You asked: “${text}”`);
    d.plan = p;
    d.planRevision = (d.planRevision ?? 0) + 1;
    d.refined = { instruction: text, changes, at: now() };
  });
}

/** Puts back the plan from before the last AI change, with the person's edits as they were. Later steps follow their fingerprints. */
export function undoRefinement(id: string) {
  const d = getProjectDraft(id);
  editable(d);
  const last = d.undo.at(-1);
  if (!last) throw invalid("There is nothing to undo.");
  d.plan = last.plan;
  d.planRevision = (d.planRevision ?? 0) + 1;
  d.undo = d.undo.slice(0, -1);
  d.refined = null;
  return drafts.save(d);
}

// ---------- 3. components ----------

const NEED_ITEM = { type: "object", additionalProperties: false,
  required: ["need", "featureIds", "status", "required", "componentSlug", "uses", "contributes", "why", "limits", "ifLeftOut", "steps"],
  properties: {
    need: { type: "string", description: "A short plain name for what the project needs, e.g. 'Weekly Instagram analysis'." },
    featureIds: { type: "array", items: { type: "string" }, description: "The plan features this need serves." },
    status: { type: "string", enum: ["available", "partial", "build", "setup"], description: "available: a library component does it. partial: a component does part. build: written inside this project. setup: needs an account, credentials, a service or scheduling the person sets up." },
    required: { type: "boolean", description: "True if the project can't do its main job without this." },
    componentSlug: { type: ["string", "null"], description: "The library component for available or partial, else null." },
    uses: { type: "array", items: { type: "string" }, description: "Exact names of that component's public functions the project will call. Empty without a component." },
    contributes: { type: "string", description: "What the component does here, based only on its real functions. Empty without a component." },
    why: { type: "string", description: "One plain sentence: why this is needed." },
    limits: { type: "string", description: "What the component doesn't do that this needs. Empty if nothing." },
    ifLeftOut: { type: "string", description: "With a component: what would be built in the project instead if the person doesn't use it." },
    steps: { type: "string", description: "For setup: what the person does, in one or two plain sentences. Else empty." },
  } };

const ANALYSIS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["language", "needs", "connections", "compatibility", "files", "nextSteps"],
  properties: {
    language: { type: "string", enum: ["python", "other"] },
    needs: { type: "array", items: NEED_ITEM },
    connections: { type: "array", items: { type: "string" }, description: "How the pieces connect, as short steps in order." },
    compatibility: { type: "array", items: { type: "string" }, description: "Anything that may not fit together, or limits. Empty if none." },
    files: { type: "array", description: "The project's own files (not components). At most 12.",
      items: { type: "object", additionalProperties: false, required: ["path", "purpose"], properties: { path: { type: "string" }, purpose: { type: "string" } } } },
    nextSteps: { type: "array", items: { type: "string" } },
  },
};

const evidenceText = (c: ReleaseInspection) => `- ${c.slug} (${c.name} ${c.version}, ${c.language || "Python"}): ${c.summary}
  Real public functions: ${c.api.map((f) => `${f.name}${f.signature}${f.doc ? ` — ${f.doc}` : ""}`).join("; ") || "(none found)"}
  Imports: ${c.imports.join(", ") || "(none)"}. Network: ${c.usesNetwork ? "yes" : "no"}. Reads files: ${c.readsFiles ? "yes" : "no"}. Environment variables: ${c.envVars.join(", ") || "none"}.
  Inputs: ${c.inputs.join("; ") || "-"}. Outputs: ${c.outputs.join("; ") || "-"}.`;

const analysisPrompt = (p: ProjectPlan, prompt: string, comps: ReleaseInspection[]) => `Work out what this project needs, and which needs the person's component library already covers.

Their first description, for context (where it differs from the plan below, the plan wins):
"""${prompt}"""

Project: ${p.name}. ${p.description}
${p.summary}
Technology: ${p.technology}
Features (id: text):
${p.features.filter((f) => f.included).map((f) => `${f.id}: ${f.text}`).join("\n")}

Components in their library, as read from each release's actual code:
${comps.map(evidenceText).join("\n") || "(none)"}

Rules:
- List each need once, linked to the feature ids it serves. Use status "available" or "partial" only when a component's real functions do that need; judge by the functions, imports and inputs, not by names. A component that reads exported data does not collect data; one with no network use cannot fetch anything. Never invent components.
- Everything else is "build" (written inside this project, not as a new library component) or "setup" (an account, credentials, a service, permissions or scheduling the person sets up; never assume anything is configured).
- If you use any component, the project must be Python 3.9 with only the standard library.
- Taking screenshots of web pages needs a browser engine that is not in Python's standard library: say so in compatibility and offer a plain alternative.
- Files: README.md, .gitignore, the project's code, and tests/test_*.py that run it with sample data and no network. At most 12. Don't list component files.
Use plain, non-technical words except function names.`;

function toAnalysis(raw: any, inspected: ReleaseInspection[], key: string, plan: ProjectPlan): ComponentAnalysis {
  if (!raw || !Array.isArray(raw.needs)) throw new LibraryError("GENERATION_FAILED", "The AI's list of needs was incomplete. Try again.");
  const list = (x: any) => (Array.isArray(x) ? x : []);
  const bySlug = new Map(inspected.map((c) => [c.slug, c]));
  const featureIds = new Set(plan.features.filter((f) => f.included).map((f) => f.id));
  const comps = new Map<string, PlannedComponent>();
  const needs: Need[] = list(raw.needs).slice(0, 30).map((n: any) => {
    let status: Need["status"] = ["available", "partial", "build", "setup"].includes(n?.status) ? n.status : "build";
    const ins = n?.componentSlug ? bySlug.get(String(n.componentSlug)) : undefined;
    let component: string | null = null;
    if ((status === "available" || status === "partial") && ins) {
      component = ins.slug;
      const api = new Set(ins.api.map((f) => f.name));
      const uses = list(n.uses).map(String).filter(Boolean);
      const prev = comps.get(ins.slug);
      const all = [...new Set([...(prev?.uses ?? []), ...uses.filter((u: string) => api.has(u))])];
      const problems: string[] = [];
      const unknown = uses.filter((u: string) => !api.has(u));
      if (unknown.length) problems.push(`It has no public ${unknown.join(", ")}: the plan named something its code doesn't have.`);
      if (!all.length) problems.push("No real function of it was named to call.");
      if (!ins.packages.length) problems.push("No Python package was found in its release, so it can't be imported.");
      if (ins.release !== "intact") problems.push(`Its ${ins.version} release files ${ins.release === "missing" ? "are missing" : "no longer match their checksum"}.`);
      if (ins.language && !/python/i.test(ins.language)) problems.push(`It is ${ins.language}, not Python.`);
      comps.set(ins.slug, {
        slug: ins.slug, name: ins.name, version: ins.version, packages: ins.packages.map((p) => p.name),
        contributes: [prev?.contributes, String(n.contributes ?? "")].filter(Boolean).join(" "), uses: all,
        fit: prev?.fit === "partial" || status === "partial" ? "partial" : "full", missing: [prev?.missing, String(n.limits ?? "")].filter(Boolean).join(" "),
        problems: [...new Set([...(prev?.problems ?? []), ...problems])],
        evidence: { functions: ins.api.filter((f) => all.includes(f.name)).map((f) => ({ name: f.name, signature: f.signature, doc: f.doc })), imports: ins.imports,
          network: ins.usesNetwork, readsFiles: ins.readsFiles, testStatus: ins.lastTestStatus, release: ins.release },
      });
    } else if (status === "available" || status === "partial") status = "build"; // named a component that isn't there: nothing is invented
    return {
      id: newId("n"), need: String(n?.need ?? "").trim().slice(0, 120) || "Unnamed need", featureIds: list(n?.featureIds).map(String).filter((x: string) => featureIds.has(x)),
      status, required: !!n?.required, component, why: String(n?.why ?? "").slice(0, 400), limits: String(n?.limits ?? "").slice(0, 400),
      ifLeftOut: String(n?.ifLeftOut ?? "").slice(0, 400), steps: String(n?.steps ?? "").slice(0, 600),
    };
  });
  return {
    key, language: comps.size || raw.language === "python" ? "python" : "other", needs, components: [...comps.values()],
    connections: list(raw.connections).map(String).filter(Boolean).slice(0, 12),
    compatibility: list(raw.compatibility).map(String).filter(Boolean).slice(0, 12),
    files: list(raw.files).map((f: any) => ({ path: String(f.path ?? ""), purpose: String(f.purpose ?? "") })).filter((f: any) => f.path).slice(0, MAX_FILES),
    nextSteps: list(raw.nextSteps).map(String).slice(0, 6),
  };
}

/** Maps the plan to components, the project and setup. Does nothing (no AI request) when the plan hasn't changed since the last time. */
export function analyzeComponents(db: DB, id: string) {
  return drafts.step(id, "components", async (d, report: Report) => {
    current(d);
    if (!d.plan) throw invalid("There is no plan yet.");
    const key = componentsKey(d.plan);
    if (d.analysis?.key === key) return; // already current
    report("Reading your components' code…");
    const all = listComponentsWithReleases(db);
    const slugs = all.length < INSPECT_ALL_BELOW ? all : discover(db, d.plan.features.filter((f) => f.included).map((f) => f.text).join(". "), { limit: 15 }).results.map((m) => m.component.slug).filter((s) => all.includes(s));
    const { inspected } = inspectAll(db, slugs);
    report("Matching your plan to your components…");
    d.analysis = toAnalysis(await ask("propose", analysisPrompt(d.plan, d.prompt, inspected), ANALYSIS_SCHEMA), inspected, key, d.plan);
    // Earlier choices carry over for components and needs that are still there.
    d.choice.useComponent = Object.fromEntries(Object.entries(d.choice.useComponent).filter(([k]) => d.analysis!.components.some((c) => c.slug === k)));
    d.choice.includeNeed = {};
  });
}

/** The person's Components choices. A required need can't be switched off here. */
export function saveChoices(id: string, choice: { useComponent?: Record<string, boolean>; includeNeed?: Record<string, boolean> }) {
  const d = getProjectDraft(id);
  editable(d);
  if (!d.analysis) throw invalid("Find components first.");
  for (const [slug, on] of Object.entries(choice.useComponent ?? {})) if (d.analysis.components.some((c) => c.slug === slug)) d.choice.useComponent[slug] = !!on;
  for (const [nid, on] of Object.entries(choice.includeNeed ?? {})) {
    const n = d.analysis.needs.find((x) => x.id === nid);
    if (!n) continue;
    if (n.required && !on) throw invalid(`“${n.need}” is needed for the project to work, so it can't be left out here. To drop it, untick its feature in Plan.`);
    d.choice.includeNeed[nid] = !!on;
  }
  return drafts.save(d);
}

export function setFolder(id: string, folder: string) {
  const d = getProjectDraft(id);
  editable(d);
  const f = folder.trim().toLowerCase();
  if (!FOLDER.test(f)) throw invalid("Folder names use lowercase letters, numbers, dots, hyphens and underscores, and start with a letter or number.");
  d.choice.folder = f;
  return drafts.save(d);
}

// ---------- 4. build in staging ----------

const BUILD_SCHEMA = {
  type: "object", additionalProperties: false, required: ["files"],
  properties: { files: { type: "array", items: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } } } },
};

function buildPrompt(d: ProjectDraft, previous?: { files: { path: string; content: string }[]; feedback: string }) {
  const p = d.plan!;
  const a = d.analysis!;
  const dec = decisions(d);
  const comps = dec.components;
  const needs = dec.needs.filter((n) => n.included);
  const line = (n: (typeof needs)[number]) => n.using ? `${n.need}: use ${comps.find((c) => c.slug === n.using)!.name}${n.status === "partial" && n.limits ? ` (and build what it doesn't do: ${n.limits})` : ""}`
    : n.status === "setup" ? `${n.need}: setup the person does (${n.steps}). Read it from environment variables or a config file and document it in README.md.`
    : `${n.need}: build it in the project${n.component && n.ifLeftOut ? ` (the person chose not to use a component here: ${n.ifLeftOut})` : ""}.`;
  return `Write the files for this project.

Their first description, for context (where it differs from the plan below, the plan wins):
"""${d.prompt}"""

Project: ${p.name}. ${p.description}
${p.summary}
Technology: ${p.technology}
What it will do:
${p.features.filter((f) => f.included).map((f) => `- ${f.text}`).join("\n")}
What it needs, and where each part comes from:
${needs.map((n) => `- ${line(n)}`).join("\n")}
${dec.needs.some((n) => !n.included) ? `Left out on purpose (don't build): ${dec.needs.filter((n) => !n.included).map((n) => n.need).join("; ")}\n` : ""}Planned files: ${JSON.stringify(a.files)}
How it connects: ${a.connections.join(" | ")}

${comps.length ? `Library components, already copied unchanged into components/<slug>/. Use them; never copy or rewrite their code.
In every module that uses them, the first import must be "import component_paths" (a file the library writes), then:
${comps.map((c) => `- ${c.name} ${c.version}:\n${c.evidence.functions.map((f) => `    from ${c.packages[0]} import ${f.name}   # ${f.name}${f.signature} — ${f.doc}`).join("\n")}
  It contributes: ${c.contributes}${c.missing ? ` It does NOT: ${c.missing}` : ""}`).join("\n")}
The project's own code (outside tests/) must import and call each of these. Do not call components only from tests.` : "This project uses no library components."}

Rules:
- ${a.language === "python" || comps.length ? "Python 3.9, standard library only. No 'match', no 'X | Y' types." : "Use plain files that need no installation."}
- tests/test_*.py (unittest) run the project's own code with sample data and check the results${comps.length ? ", and must exercise the code paths that call the components" : ""}. Give each test a clear name. Tests run in a sandbox with no network and no files outside a temp folder: put sample data in the test, and mock anything that sends email or fetches from the internet with unittest.mock.
- Never put passwords, keys, tokens or webhook URLs in files. Read configuration from environment variables and document them in README.md, with the setup steps.
- Do not run other programs (no subprocess, os.system), delete files, or use eval/exec.
- Do not write anything under components/, and do not write component_paths.py or tests/test_components_match_release.py (the library writes those).
- Plain relative paths only. Allowed: .md .txt .py .js .ts .json .html .css .toml .yaml .cfg .ini .svg .csv and .gitignore. At most ${MAX_FILES} files.
${previous ? `\nThis is another attempt. The previous version had this problem:\n"""${previous.feedback}"""\n\nPrevious files:\n${previous.files.map((f) => `--- ${f.path}\n${f.content}`).join("\n")}\n\nFix the problem and return the complete set of files.` : ""}`;
}

function vetFiles(raw: any): { path: string; content: string }[] {
  const files = Array.isArray(raw?.files) ? raw.files : null;
  if (!files?.length) throw new LibraryError("GENERATION_FAILED", "The AI returned no files. Try again.");
  if (files.length > MAX_FILES) throw new LibraryError("GENERATION_FAILED", `The AI returned more than ${MAX_FILES} files.`);
  const seen = new Set<string>();
  return files.map((f: any) => {
    const p = String(f?.path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
    const bad = (why: string) => new LibraryError("GENERATION_FAILED", `The AI returned a file that isn't allowed, "${p || "(no name)"}": ${why}. Nothing was written. Try again.`);
    if (!p || p.startsWith("/") || p.split("/").some((s) => s === "" || s === ".." || (s.startsWith(".") && !ALLOWED_DOTFILES.has(s)))) throw bad("only plain relative paths inside the project are allowed");
    if (p === "components" || p.startsWith("components/") || RESERVED.has(p)) throw bad("the library writes that itself");
    if (!ALLOWED_EXT.test(p) && !ALLOWED_DOTFILES.has(path.basename(p))) throw bad("that kind of file isn't allowed");
    if (excludedReason(path.basename(p)) && !ALLOWED_DOTFILES.has(path.basename(p))) throw bad(String(excludedReason(path.basename(p))));
    const content = String(f?.content ?? "");
    if (Buffer.byteLength(content) > MAX_BYTES) throw bad("it is over 100 KB");
    if (seen.has(p.toLowerCase())) throw bad("it appears twice");
    seen.add(p.toLowerCase());
    return { path: p, content };
  });
}

const USAGE_SCRIPT = String.raw`
import ast, json, sys
spec = json.loads(sys.argv[1])
out = {slug: {"imported": False, "called": []} for slug in spec["packages"]}
def owner(top):
    for slug, pkgs in spec["packages"].items():
        if top in pkgs: return slug
for path in spec["files"]:
    try:
        with open(path, encoding="utf-8") as f: tree = ast.parse(f.read())
    except Exception: continue
    names, modules = {}, {}
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom) and n.level == 0 and n.module and owner(n.module.split(".")[0]):
            slug = owner(n.module.split(".")[0]); out[slug]["imported"] = True
            for a in n.names: names[a.asname or a.name] = slug
        elif isinstance(n, ast.Import):
            for a in n.names:
                slug = owner(a.name.split(".")[0])
                if slug: out[slug]["imported"] = True; modules[(a.asname or a.name).split(".")[0]] = slug
    for n in ast.walk(tree):
        if not isinstance(n, ast.Call): continue
        f = n.func
        if isinstance(f, ast.Name) and f.id in names:
            slug, fn = names[f.id], f.id
        elif isinstance(f, ast.Attribute):
            base = f.value
            while isinstance(base, ast.Attribute): base = base.value
            if not (isinstance(base, ast.Name) and base.id in modules): continue
            slug, fn = modules[base.id], f.attr
        else: continue
        if fn in spec["api"][slug] and fn not in out[slug]["called"]: out[slug]["called"].append(fn)
print(json.dumps(out))
`;

/** Which components the project's own code (not tests, not the copies) imports and calls. Read with Python's parser; nothing runs. */
export function usageOf(dir: string, comps: { slug: string; packages: string[]; api: string[] }[], files: string[]) {
  if (!comps.length) return {};
  const own = files.filter((f) => f.endsWith(".py") && !f.startsWith("tests/") && !f.startsWith("components/") && f !== "component_paths.py").map((f) => path.join(dir, f));
  const spec = { files: own, packages: Object.fromEntries(comps.map((c) => [c.slug, c.packages])), api: Object.fromEntries(comps.map((c) => [c.slug, c.api])) };
  return JSON.parse(execFileSync(PYTHON, ["-I", "-c", USAGE_SCRIPT, JSON.stringify(spec)], { encoding: "utf8", timeout: 20_000 })) as Record<string, { imported: boolean; called: string[] }>;
}

export function readyToBuild(db: DB, d: ProjectDraft): string[] {
  if (d.legacy || d.plan === undefined) return [LEGACY];
  if (!d.plan) return ["There is no plan yet."];
  const f = freshness(d);
  if (f.components === "missing") return ["Find components for the plan first."];
  if (f.components === "outdated") return ["The plan changed after the components were matched. Go to Components to update them."];
  const problems: string[] = [];
  const root = projectsRoot(db);
  if (!root.allowed) problems.push(`The projects location ${root.path} is outside your allowed folders. Change it in Settings.`);
  if (!d.plan.name.trim()) problems.push("The project needs a name.");
  if (!FOLDER.test(d.choice.folder)) problems.push("Choose a folder name: lowercase letters, numbers and hyphens.");
  else if (fs.existsSync(path.join(root.path, d.choice.folder))) problems.push(`${path.join(root.path, d.choice.folder)} already exists. Choose a different folder name; existing folders are never overwritten.`);
  if (listProjects(db).some((p) => p.path === path.join(root.path, d.choice.folder))) problems.push("A project in the library already uses that folder.");
  for (const c of includedComponents(d)) {
    try { if (verifyRelease(db, c.slug, c.version).state !== "intact") problems.push(`${c.name} ${c.version}'s release files no longer match their checksum, so it can't be copied.`); }
    catch { problems.push(`${c.name} ${c.version} is no longer in the library.`); }
  }
  return problems;
}

/** Writes the project in staging. With nothing changed and no fix asked for, it keeps the current build (no AI request). */
export function buildProject(db: DB, id: string, feedback = "") {
  return drafts.step(id, "build", async (d, report: Report) => {
    current(d);
    if (!feedback.trim() && d.build && freshness(d).build === "current") return;
    report("Preparing the project…");
    const blockers = readyToBuild(db, d);
    if (blockers.length) throw invalid(blockers.join(" "));
    const key = buildKey(d);
    const comps = includedComponents(d);
    const previous = feedback.trim() && d.build && d.build.key === key ? { files: readProjectFiles(d), feedback: feedback.trim() } : undefined;
    report(previous ? "Fixing the project…" : "Writing the project's code…");
    const files = vetFiles(await ask<{ files?: unknown }>("generate", buildPrompt(d, previous), BUILD_SCHEMA));

    report("Copying the components and checking the files…");
    const dir = buildDir(d);
    const stage = path.join(drafts.dir(d.id), "build.new");
    const fresh = path.join(stage, path.basename(dir));
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(fresh, { recursive: true });
    const copies = comps.map((c) => writeComponentCopy(db, fresh, c.slug, c.version));
    if (copies.length) {
      fs.writeFileSync(path.join(fresh, "component_paths.py"), componentPathsFile(copies));
      fs.mkdirSync(path.join(fresh, "tests"), { recursive: true });
      fs.writeFileSync(path.join(fresh, "tests", "test_components_match_release.py"), matchTestFile(copies));
    }
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(fresh, f.path)), { recursive: true });
      fs.writeFileSync(path.join(fresh, f.path), f.content, { flag: "wx" });
    }
    // Only one staged build is kept: the one for the current folder.
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    fs.renameSync(stage, path.dirname(dir));

    const problems: string[] = [];
    const notes: string[] = [];
    const secrets = findSecrets(files.map((f) => path.join(dir, f.path))).map((s) => `${path.relative(dir, s.file)}:${s.line}`);
    if (secrets.length) problems.push(`${secrets.length} line(s) look like a password, key or webhook (${secrets.join(", ")}).`);
    const py = files.filter((f) => f.path.endsWith(".py"));
    if (d.analysis!.language === "python" || comps.length) {
      const local = new Set([...py.map((f) => f.path.split("/")[0].replace(/\.py$/, "")), ...py.map((f) => path.basename(f.path, ".py")), "component_paths", ...copies.flatMap((c) => c.packages)]);
      const imported = new Set<string>();
      for (const f of py) for (const m of f.content.matchAll(/^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*))/gm))
        for (const mod of (m[1] ? [m[1]] : m[2].split(",").map((x) => x.trim()))) { const top = mod.split(".")[0]; if (!local.has(top)) imported.add(top); }
      const std = standardLibrary([...imported]);
      const outside = [...imported].filter((m) => !std[m]);
      if (outside.length) problems.push(`It imports ${outside.join(", ")}, which is not part of Python's standard library. Nothing is installed automatically.`);
      if (!files.some((f) => /^tests\/test_[^/]+\.py$/.test(f.path))) (comps.length ? problems : notes).push("There are no tests (tests/test_*.py).");
    }
    const all = py.map((f) => f.content).join("\n");
    if (/\b(subprocess|os\.system|os\.popen)\b/.test(all)) notes.push("It runs other programs. Read the code before using it.");
    if (/\b(urllib\.request|http\.client|smtplib|socket)\b/.test(all)) notes.push("It uses the network when you run it (its tests can't: they run without network).");

    const usage = usageOf(dir, copies.map((c) => ({ slug: c.slug, packages: c.packages, api: c.api })), files.map((f) => f.path));
    for (const c of comps) {
      const u = usage[c.slug];
      if (!u?.imported) problems.push(`The project's code doesn't import ${c.name}, so it isn't really using it. Use Fix, or leave the component out.`);
      else if (!u.called.length) problems.push(`The project's code imports ${c.name} but never calls any of its functions.`);
    }
    d.build = {
      key, attempt: (d.build?.attempt ?? 0) + 1, at: now(), feedback: feedback.trim(), problems, notes, usage,
      files: walk(dir).map((rel) => ({ path: rel, bytes: fs.statSync(path.join(dir, rel)).size,
        owner: rel.startsWith("components/") ? "component" : RESERVED.has(rel) ? "library" : "project" })),
    };
    d.tests = null;
  });
}

/** The project's own files and the library's helper files (not the copied components), for review. */
export function readProjectFiles(d: ProjectDraft): { path: string; content: string }[] {
  if (!d.build || !fs.existsSync(buildDir(d))) return [];
  return d.build.files.filter((f) => f.owner !== "component").map((f) => ({ path: f.path, content: fs.readFileSync(path.join(buildDir(d), f.path), "utf8") }));
}

// ---------- 5. test in the sandbox ----------

/** Runs the tests. Results for the same files are kept unless asked to run again. */
export function testProject(db: DB, id: string, again = false) {
  return drafts.step(id, "tests", async (d, report: Report) => {
    current(d);
    if (!d.build) throw invalid("Build the project first.");
    if (freshness(d).build !== "current") throw invalid("The plan or choices changed after this build. Build it again first.");
    if (d.build.problems.length) throw invalid(`The checks found problems, so its code will not be run: ${d.build.problems.join(" ")}`);
    if (!again && freshness(d).tests === "current") return;
    report("Running the project's tests in the sandbox…");
    const t0 = Date.now();
    const at = now();
    const result = await runShell(sandboxedTraceCommand(), buildDir(d), getSettings(db).testTimeoutSeconds * 1000);
    d.tests = { ...result, at, durationMs: Date.now() - t0, checksum: buildChecksum(d), calls: componentCalls(result.stdout) };
  });
}

/** Each test by name, from unittest's detailed output. */
export function testList(d: ProjectDraft): { name: string; file: string; passed: boolean; outcome: string; copiesMatch: boolean }[] {
  if (!d.tests) return [];
  const text = `${d.tests.stderr}\n${d.tests.stdout}`;
  const out: ReturnType<typeof testList> = [];
  for (const m of text.matchAll(/^(test\w*) \(([^)\s]+)\)(?: \.\.\. |\n.*? \.\.\. )(ok|FAIL|ERROR|skipped.*|expected failure|unexpected success)$/gm)) {
    const mod = m[2].split(".").slice(0, -1).join(".") || m[2];
    out.push({ name: m[1].replace(/^test_?/, "").replace(/_/g, " ") || m[1], file: mod, passed: m[3] === "ok" || m[3] === "expected failure" || m[3].startsWith("skipped"), outcome: m[3], copiesMatch: /test_components_match_release/.test(m[2]) });
  }
  return out;
}

/** Per included component: connected only when the code uses it and the passing tests called it. */
export function connections(d: ProjectDraft): Record<string, { connected: boolean; why: string }> {
  const out: Record<string, { connected: boolean; why: string }> = {};
  const f = freshness(d);
  for (const c of includedComponents(d)) {
    const u = d.build?.usage[c.slug];
    const calls = d.tests?.calls[c.slug] ?? [];
    if (!d.build || f.build !== "current") out[c.slug] = { connected: false, why: "Not built yet." };
    else if (!u?.imported || !u.called.length) out[c.slug] = { connected: false, why: "The project's code doesn't call it." };
    else if (!d.tests) out[c.slug] = { connected: false, why: "Not tested yet." };
    else if (f.tests !== "current") out[c.slug] = { connected: false, why: "The files changed after the tests ran." };
    else if (d.tests.status !== "passed") out[c.slug] = { connected: false, why: `The tests ${d.tests.status}.` };
    else if (!calls.length) out[c.slug] = { connected: false, why: "The tests passed but never called it, so the connection isn't verified." };
    else out[c.slug] = { connected: true, why: `The project's code calls ${u.called.join(", ")}, and its passing tests called ${calls.join(", ")}.` };
  }
  return out;
}

export function readyToCreate(db: DB, d: ProjectDraft): { target: string | null; problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const root = projectsRoot(db);
  if (root.iCloud) warnings.push(root.iCloud);
  if (!d.plan || d.legacy) return { target: null, problems: ["There is no plan yet."], warnings };
  problems.push(...readyToBuild(db, d));
  const f = freshness(d);
  if (!d.build) problems.push("Build the project first.");
  else if (f.build !== "current") problems.push("The plan or choices changed after this build. Build it again.");
  else {
    problems.push(...d.build.problems);
    const comps = includedComponents(d);
    const hasTests = d.build.files.some((x) => /^tests\/test_.+\.py$/.test(x.path));
    if (comps.length || hasTests) {
      if (!d.tests) problems.push("Run the tests first.");
      else if (f.tests !== "current") problems.push("The files changed after the tests ran. Run them again.");
      else if (d.tests.status !== "passed") problems.push(`The tests ${d.tests.status}. Use Fix, then run them again.`);
    }
    for (const [slug, s] of Object.entries(connections(d))) if (!s.connected && d.tests) problems.push(`${comps.find((c) => c.slug === slug)!.name} isn't connected: ${s.why}`);
  }
  const target = FOLDER.test(d.choice.folder) ? path.join(root.path, d.choice.folder) : null;
  return { target, problems: [...new Set(problems)], warnings };
}

// ---------- create: files and records together ----------

export function createProject(db: DB, id: string) {
  return drafts.step(id, "create", async (d, report: Report) => {
    current(d);
    const ready = readyToCreate(db, d);
    if (ready.problems.length || !ready.target) throw invalid(ready.problems.join(" "));
    const root = projectsRoot(db);
    report("Creating the project folder…");
    if (!root.exists) fs.mkdirSync(root.path, { recursive: true });
    const realRoot = checkPath(db, root.path, "directory").path;
    const target = path.join(realRoot, d.choice.folder);
    const staged = buildChecksum(d);
    fs.mkdirSync(target); // fails if it exists: never overwrites
    try {
      report("Writing the project's files…");
      for (const rel of walk(buildDir(d))) {
        const out = path.join(target, rel);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.copyFileSync(path.join(buildDir(d), rel), out, fs.constants.COPYFILE_EXCL);
      }
      if (treeChecksum(target).checksum !== staged) throw new LibraryError("VALIDATION", "The files written don't match the tested files, so nothing was recorded.");
      report("Adding it to the library…");
      const conn = connections(d);
      const comps = includedComponents(d);
      // The project and every component link are recorded together, or not at all.
      const p = db.transaction(() => {
        const proj = registerProject(db, { path: target, name: d.plan!.name, description: d.plan!.description });
        for (const c of comps) {
          linkComponent(db, proj.id, c.slug, `Copied unchanged into components/${c.slug}/ when the project was created.`, c.version);
          setIntegration(db, proj.id, c.slug, "connected", `${conn[c.slug].why} Checked in staging on ${d.tests!.at}; the created files match the tested ones.`);
        }
        return proj;
      })();
      d.project = { id: p.id, path: p.path };
    } catch (err) {
      fs.rmSync(target, { recursive: true, force: true }); // only the folder made just now; the database step happened fully or not at all
      throw err;
    }
  });
}
