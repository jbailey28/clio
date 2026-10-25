import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db";
import { libraryCodeDir } from "./db";
import { LibraryError, invalid } from "./errors";
import { getCategory, listCategories } from "./categories";
import { getComponent, recordActivity } from "./components";
import { discover, findDuplicates } from "./discovery";
import { excludedReason, findSecrets, registerPackagedComponent, type SecretFinding } from "./packaging";
import { createRelease, releasesDir, treeChecksum } from "./releases";
import { getSettings } from "./settings";
import { runComponentTests, runShell, type ShellResult } from "./testing";
import { ask } from "./generator";
import { activeStep, draftStore, stagingRoot, type DraftBase, type Report } from "./drafts";
import { sandboxedPythonTestCommand, standardLibrary } from "./sandbox";
import { newId, now, slugify, validSlug } from "./util";

/**
 * Creating a component from a plain-English description, in the browser.
 *
 * A draft lives in its own staging folder (<data>/staging/<id>/): draft.json
 * holds where it is, build/<slug>/ holds the generated files. Nothing reaches
 * the library until the last step, which uses the same registration, testing
 * and release code as every other component. Each step that matters needs the
 * person to press its button: generate, run tests, register and release.
 */

// ---------- shapes ----------

export interface Proposal {
  name: string;
  summary: string;
  category: { slug: string | null; newName: string | null; reason: string };
  inputs: { name: string; type: string; description: string }[];
  outputs: { name: string; type: string; description: string }[];
  approach: string;
  capabilities: { name: string; description: string }[];
  tests: string;
  /** Packages outside Python's standard library that this would need. Non-empty means it can't be built here. */
  needsPackages: string[];
  /** Asked only when the description is too unclear to build from. */
  questions: string[];
  /** The AI's judgement of each library component the search shortlisted. */
  existing: { slug: string; verdict: "same" | "partial" | "different"; covers: string; missing: string }[];
}

export interface Checks {
  ok: boolean;
  /** Each one stops the component until it is fixed. */
  problems: string[];
  /** Worth knowing; does not stop it. */
  notes: string[];
  secrets: SecretFinding[];
  imports: string[];
}

export interface Draft extends DraftBase {
  prompt: string;
  answers: { question: string; answer: string }[];
  proposal: Proposal | null;
  /** What the person settled on. Category is a slug; "" until chosen. */
  choice: { name: string; summary: string; category: string };
  generation: { attempt: number; at: string; files: { path: string; bytes: number }[]; checks: Checks; usage: string; feedback: string } | null;
  tests: (ShellResult & { at: string; durationMs: number; filesChecksum: string }) | null;
  component: { slug: string; version: string } | null;
}

export type Stage = "asking" | "proposed" | "generated" | "tested" | "released";

export function stageOf(d: Draft): Stage {
  if (d.component) return "released";
  if (d.generation && d.tests?.status === "passed" && d.tests.filesChecksum === buildChecksum(d)) return "tested";
  if (d.generation) return "generated";
  if (d.proposal && d.proposal.questions.length && d.answers.length === 0) return "asking";
  return "proposed";
}

// ---------- storage (shared draft store) ----------

const drafts = draftStore<Draft>("drf", "Draft");
export { stagingRoot, activeStep };
export const getDraft = drafts.get;
const save = drafts.save;
const step = drafts.step;
export const discardDraft = drafts.discard;
export const ownsDraft = drafts.owns;

export const buildDir = (d: Draft) => path.join(drafts.dir(d.id), "build", slugOf(d));
const slugOf = (d: Draft) => slugify(d.choice.name || "component");
const packageOf = (d: Draft) => slugOf(d).replace(/-/g, "_");
const buildChecksum = (d: Draft) => (fs.existsSync(buildDir(d)) ? treeChecksum(buildDir(d)).checksum : "");

/** Unfinished drafts, newest first. */
export function listDrafts(): Draft[] {
  return drafts.list().filter((d) => !d.component);
}

/** Files of the generated component, for review. */
export function readBuild(d: Draft): { path: string; content: string }[] {
  if (!d.generation) return [];
  return d.generation.files.map((f) => ({ path: f.path, content: fs.readFileSync(path.join(buildDir(d), f.path), "utf8") }));
}

// ---------- 1. describe and propose ----------

const PROPOSAL_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["name", "summary", "category", "inputs", "outputs", "approach", "capabilities", "tests", "needsPackages", "questions", "existing"],
  properties: {
    name: { type: "string", description: "Short Title Case name, 2 to 5 words." },
    summary: { type: "string", description: "One or two plain sentences: what it does, for someone who does not code." },
    category: {
      type: "object", additionalProperties: false, required: ["slug", "newName", "reason"],
      properties: {
        slug: { type: ["string", "null"], description: "Slug of the best existing category, or null if none fits." },
        newName: { type: ["string", "null"], description: "Only when no existing category fits: a name for a new one." },
        reason: { type: "string" },
      },
    },
    inputs: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "type", "description"], properties: { name: { type: "string" }, type: { type: "string" }, description: { type: "string" } } } },
    outputs: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "type", "description"], properties: { name: { type: "string" }, type: { type: "string" }, description: { type: "string" } } } },
    approach: { type: "string", description: "How it will work, in two or three plain sentences." },
    capabilities: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "description"], properties: { name: { type: "string" }, description: { type: "string" } } } },
    tests: { type: "string", description: "What the tests will check, in plain words." },
    needsPackages: { type: "array", items: { type: "string" }, description: "Python packages outside the standard library it truly needs. Empty if the standard library is enough." },
    questions: { type: "array", items: { type: "string" }, description: "Only if the description is too unclear to build from: at most 3 short questions. Otherwise empty." },
    existing: {
      type: "array", description: "One entry per existing library component listed in the prompt.",
      items: {
        type: "object", additionalProperties: false, required: ["slug", "verdict", "covers", "missing"],
        properties: {
          slug: { type: "string" },
          verdict: { type: "string", enum: ["same", "partial", "different"], description: "same: it already does what was asked. partial: it does part of it. different: another job." },
          covers: { type: "string", description: "What part of the request it already does, in plain words. Empty if different." },
          missing: { type: "string", description: "What it does not do that was asked. Empty if same." },
        },
      },
    },
  },
};

/** The components the Milestone 6 search shortlists for this request, with what the AI needs to judge them. */
function candidates(db: DB, d: Pick<Draft, "prompt">) {
  return discover(db, d.prompt, { limit: 5 }).results.map((m) => {
    const c = getComponent(db, m.component.id);
    return { slug: c.slug, name: c.name, summary: c.summary, capabilities: c.capabilities.filter((x) => x.kind === "capability").map((x) => `${x.name}: ${x.description}`) };
  });
}

function proposalPrompt(db: DB, d: Pick<Draft, "prompt" | "answers">): string {
  const found = candidates(db, d);
  const cats = listCategories(db).map((c) => `- ${c.slug}: ${c.name}${c.description ? ` (${c.description})` : ""}`).join("\n") || "(none yet)";
  return `You are planning a small, reusable software component for someone who does not code.
It will be written in Python 3.9 using only the standard library, with tests for Python's built-in unittest.

Their description:
"""${d.prompt}"""
${d.answers.length ? `\nTheir answers to your earlier questions:\n${d.answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n")}\n` : ""}
Existing categories (pick the best fitting slug, or null and suggest a new name only if none fits):
${cats}

Existing library components that might already do this (judge each one honestly in "existing"; a shared word is not a match,
only the job matters):
${found.length ? found.map((c) => `- ${c.slug}: ${c.name}. ${c.summary}\n  Does: ${c.capabilities.join("; ")}`).join("\n") : "(none)"}

Work out the name, what it does, inputs and outputs, approach, capabilities and tests yourself. Ask questions only if you
genuinely cannot build it without an answer${d.answers.length ? " (they have already answered once, so ask nothing more unless essential)" : ""}.
If it would need a package outside the standard library, list it in needsPackages. Use plain, non-technical words in summary, approach and tests.`;
}

function cleanProposal(raw: any): Proposal {
  if (!raw || typeof raw.name !== "string" || typeof raw.summary !== "string" || !raw.name.trim())
    throw new LibraryError("GENERATION_FAILED", "The AI's proposal was incomplete (no name or description). Try again, or describe it differently.");
  const list = (x: any) => (Array.isArray(x) ? x : []);
  return {
    name: raw.name.trim().slice(0, 80),
    summary: String(raw.summary).trim().slice(0, 1000),
    category: { slug: raw.category?.slug ?? null, newName: raw.category?.newName ?? null, reason: String(raw.category?.reason ?? "") },
    inputs: list(raw.inputs).map((i: any) => ({ name: String(i.name), type: String(i.type ?? ""), description: String(i.description ?? "") })),
    outputs: list(raw.outputs).map((i: any) => ({ name: String(i.name), type: String(i.type ?? ""), description: String(i.description ?? "") })),
    approach: String(raw.approach ?? ""),
    capabilities: list(raw.capabilities).map((c: any) => ({ name: String(c.name), description: String(c.description ?? "") })).filter((c: any) => c.name.trim()),
    tests: String(raw.tests ?? ""),
    needsPackages: list(raw.needsPackages).map(String).filter(Boolean),
    questions: list(raw.questions).map(String).filter(Boolean).slice(0, 3),
    existing: list(raw.existing)
      .filter((e: any) => typeof e?.slug === "string" && ["same", "partial", "different"].includes(e.verdict))
      .map((e: any) => ({ slug: e.slug, verdict: e.verdict, covers: String(e.covers ?? ""), missing: String(e.missing ?? "") })),
  };
}

async function propose(db: DB, d: Draft, report: Report) {
  report("Checking your library…");
  const prompt = proposalPrompt(db, d);
  report("Writing the proposal…");
  const p = cleanProposal(await ask("propose", prompt, PROPOSAL_SCHEMA));
  d.proposal = p;
  const exists = p.category.slug && listCategories(db).some((c) => c.slug === p.category.slug);
  d.choice = { name: d.choice.name || p.name, summary: d.choice.summary || p.summary, category: d.choice.category || (exists ? p.category.slug! : "") };
}

/** Starts a draft from a description and asks the AI for a proposal. The draft is kept even if that fails, so it can be retried. */
export async function startDraft(db: DB, prompt: string): Promise<Draft> {
  const text = prompt.trim();
  if (text.length < 10) throw invalid("Describe the component in a sentence or two, so there is something to build from.");
  if (text.length > 4000) throw invalid("That description is very long. Keep it under 4,000 characters.");
  const d = save({
    id: newId("drf"), createdAt: now(), updatedAt: now(), prompt: text, answers: [], proposal: null,
    choice: { name: "", summary: "", category: "" }, generation: null, tests: null, component: null, lastError: null, busy: null,
  });
  await retryProposal(db, d.id).catch(() => {}); // the error is saved on the draft and shown there
  return getDraft(d.id);
}

export function retryProposal(db: DB, id: string) {
  return step(id, "proposal", (d, report) => propose(db, d, report));
}

export function answerQuestions(db: DB, id: string, answers: string[]) {
  return step(id, "proposal", async (d, report) => {
    if (!d.proposal?.questions.length) throw invalid("There are no questions to answer.");
    const given = d.proposal.questions.map((q, i) => ({ question: q, answer: (answers[i] ?? "").trim() }));
    if (given.some((a) => !a.answer)) throw invalid("Answer each question, even briefly.");
    d.answers = given;
    d.choice = { name: "", summary: "", category: d.choice.category };
    await propose(db, d, report);
  });
}

// ---------- 2. edit name, description, category ----------

export function editChoice(db: DB, id: string, patch: { name?: string; summary?: string; category?: string }) {
  const d = getDraft(id);
  if (d.component) throw invalid("This component is already in the library. Edit it there.");
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw invalid("The component needs a name.");
    if (d.generation && name !== d.choice.name) throw invalid("The name can't change after the code is generated, because it names the code. Start over to rename it.");
    validSlug(slugify(name), "Name");
    d.choice.name = name.slice(0, 80);
  }
  if (patch.summary !== undefined) {
    if (!patch.summary.trim()) throw invalid("Say what the component does.");
    d.choice.summary = patch.summary.trim().slice(0, 1000);
  }
  if (patch.category !== undefined) d.choice.category = patch.category ? getCategory(db, patch.category).slug : "";
  return save(d);
}

// ---------- 3. generate ----------

const GENERATION_SCHEMA = {
  type: "object", additionalProperties: false, required: ["files", "usage"],
  properties: {
    files: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } },
    },
    usage: { type: "string", description: "Two to four plain sentences: how another project uses it, with a short Python example." },
  },
};

/** Everything that must be true before code is generated, checked on the server. */
export function readyToGenerate(db: DB, d: Draft): string[] {
  const problems: string[] = [];
  if (!d.proposal) problems.push("There is no proposal yet.");
  else if (d.proposal.needsPackages.length)
    problems.push(`It needs ${d.proposal.needsPackages.join(", ")}, which is not part of Python's standard library. Packages are never installed automatically, so this can't be built here.`);
  if (!d.choice.category) problems.push("Choose a category first. Every component belongs to exactly one category.");
  else try { getCategory(db, d.choice.category); } catch { problems.push(`The category "${d.choice.category}" no longer exists. Choose another.`); }
  if (!d.choice.name.trim()) problems.push("The component needs a name.");
  const slug = slugOf(d);
  const taken = db.prepare("SELECT name FROM components WHERE slug = ? OR name = ? COLLATE NOCASE").get(slug, d.choice.name.trim()) as { name: string } | undefined;
  if (taken) problems.push(`"${taken.name}" is already in the library with that name. Reuse it, or choose a different name.`);
  if (fs.existsSync(path.join(libraryCodeDir(), slug))) problems.push(`The library already has a folder called ${slug}. Choose a different name.`);
  return problems;
}

function generationPrompt(d: Draft, previous?: { files: { path: string; content: string }[]; feedback: string }): string {
  const p = d.proposal!;
  const pkg = packageOf(d);
  return `Write a small, reusable Python component.

Name: ${d.choice.name}
What it does: ${d.choice.summary}
Original description: """${d.prompt}"""
Inputs: ${JSON.stringify(p.inputs)}
Outputs: ${JSON.stringify(p.outputs)}
Approach: ${p.approach}
Capabilities: ${JSON.stringify(p.capabilities)}
Tests should check: ${p.tests}

Rules (all required):
- Python 3.9, standard library only. No third-party packages. Do not use features newer than 3.9 (no "match", no "X | Y" type unions).
- Files, as relative paths:
  - ${pkg}/__init__.py and any other modules inside ${pkg}/
  - tests/test_${pkg}.py (and more tests/test_*.py if useful), using unittest, importing with "from ${pkg} import ...".
  - README.md: what it does, inputs, outputs, how to use it.
- The tests run in a sandbox with NO network and NO file access outside a temp folder. Tests must never use the network:
  test functions that fetch data by passing in sample data, or by mocking the fetch with unittest.mock.
- Keep functions that fetch (network, files) separate from functions that analyze, so the analysis is testable without them.
- Never put passwords, API keys, tokens or webhook URLs in the code. If configuration is needed, read it from an environment variable and say which in README.md.
- Do not run other programs (no subprocess, os.system), do not delete files, do not use eval or exec.
- Clear errors for bad input. Small, readable code with docstrings.
${previous ? `
This is another attempt. The previous version had this problem:
"""${previous.feedback}"""

Previous files:
${previous.files.map((f) => `--- ${f.path}\n${f.content}`).join("\n")}

Fix the problem. Return the complete set of files again.` : ""}`;
}

const ALLOWED_EXT = /\.(py|md|txt|json)$/;
const MAX_FILES = 40;
const MAX_FILE_BYTES = 200 * 1024;

/** Turns the AI's answer into a safe list of files, or explains why it can't. Nothing is written here. */
function vetFiles(d: Draft, raw: any): { path: string; content: string }[] {
  const files = Array.isArray(raw?.files) ? raw.files : null;
  if (!files?.length) throw new LibraryError("GENERATION_FAILED", "The AI returned no files. Try again.");
  if (files.length > MAX_FILES) throw new LibraryError("GENERATION_FAILED", `The AI returned ${files.length} files; the limit is ${MAX_FILES}.`);
  const pkg = packageOf(d);
  const seen = new Set<string>();
  return files.map((f: any) => {
    const p = String(f?.path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
    const content = String(f?.content ?? "");
    const bad = (why: string) => new LibraryError("GENERATION_FAILED", `The AI returned a file that isn't allowed, "${p || "(no name)"}": ${why}. Nothing was written.`);
    if (!p || p.startsWith("/") || p.split("/").some((s: string) => s === ".." || s === "" || s.startsWith("."))) throw bad("only plain relative paths inside the component are allowed");
    if (!(p.startsWith(`${pkg}/`) || p.startsWith("tests/") || p === "README.md")) throw bad(`files must be inside ${pkg}/ or tests/, or be README.md`);
    if (!ALLOWED_EXT.test(p)) throw bad("only .py, .md, .txt and .json files are allowed");
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw bad("it is over 200 KB");
    if (seen.has(p)) throw bad("it appears twice");
    seen.add(p);
    return { path: p, content };
  });
}

/** The security and structure checks a generated component must pass before its code runs. */
export function checkBuild(d: Draft, files: { path: string; content: string }[]): Checks {
  const problems: string[] = [];
  const notes: string[] = [];
  const pkg = packageOf(d);
  const dir = buildDir(d);
  const py = files.filter((f) => f.path.endsWith(".py"));
  if (!files.some((f) => f.path === `${pkg}/__init__.py`)) problems.push(`There is no ${pkg}/__init__.py, so the component can't be imported.`);
  if (!files.some((f) => /^tests\/test_[^/]+\.py$/.test(f.path))) problems.push("There are no tests (tests/test_*.py).");
  for (const f of files) { const why = excludedReason(path.basename(f.path)); if (why) problems.push(`${f.path} is the kind of file that is never kept in the library (${why}).`); }
  const secrets = findSecrets(files.map((f) => path.join(dir, f.path))).map((s) => ({ ...s, file: path.relative(dir, s.file) }));
  if (secrets.length) problems.push(`${secrets.length} line(s) look like a password, key or webhook: ${secrets.map((s) => `${s.file}:${s.line}`).join(", ")}.`);

  // Imports: only the component itself and Python's standard library.
  const local = new Set([pkg, ...py.map((f) => path.basename(f.path, ".py"))]);
  const names = new Set<string>();
  for (const f of py)
    for (const m of f.content.matchAll(/^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*))/gm)) {
      const mods = m[1] ? [m[1]] : m[2].split(",").map((s) => s.trim());
      for (const mod of mods) { const top = mod.split(".")[0]; if (!local.has(top)) names.add(top); }
    }
  const imports = [...names].sort();
  if (imports.length) {
    const std = standardLibrary(imports);
    const outside = imports.filter((m) => !std[m]);
    if (outside.length) problems.push(`It imports ${outside.join(", ")}, which is not part of Python's standard library. Nothing is installed automatically.`);
  }

  const all = py.map((f) => f.content).join("\n");
  const flag = (re: RegExp, note: string) => { if (re.test(all)) notes.push(note); };
  flag(/\b(urllib\.request|http\.client|socket|urlopen|ftplib|smtplib)\b/, "It uses the network when you run it (its tests can't: they run without network).");
  flag(/\b(subprocess|os\.system|os\.popen|os\.exec\w*|pty\.spawn)\b/, "It runs other programs. Read the code before using it.");
  flag(/\b(shutil\.rmtree|os\.remove|os\.unlink|os\.rmdir)\b/, "It can delete files. Read the code before using it.");
  flag(/\b(eval|exec)\s*\(/, "It uses eval or exec. Read the code before using it.");
  const envs = [...new Set([...all.matchAll(/os\.(?:environ(?:\.get)?\(?\[?|getenv\()\s*["']([A-Z0-9_]+)["']/g)].map((m) => m[1]))];
  if (envs.length) notes.push(`It reads configuration from ${envs.join(", ")}.`);
  return { ok: problems.length === 0, problems, notes, secrets, imports };
}

/** Generates (or regenerates) the files into a fresh build folder, then checks them. Nothing runs. */
export function generate(db: DB, id: string, feedback = "") {
  return step(id, "generate", async (d, report) => {
    report("Preparing your component…");
    const blockers = readyToGenerate(db, d);
    if (blockers.length) throw invalid(blockers.join(" "));
    const previous = feedback.trim() && d.generation ? { files: readBuild(d), feedback: feedback.trim() } : undefined;
    report(previous ? "Fixing the code…" : "Generating code…");
    const raw = await ask<{ files?: unknown; usage?: unknown }>("generate", generationPrompt(d, previous), GENERATION_SCHEMA);
    report("Checking the files for safety…");
    const files = vetFiles(d, raw);
    const dir = buildDir(d);
    const fresh = `${dir}.new`;
    fs.rmSync(fresh, { recursive: true, force: true });
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(fresh, f.path)), { recursive: true });
      fs.writeFileSync(path.join(fresh, f.path), f.content, { flag: "wx" });
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(fresh, dir);
    d.generation = {
      attempt: (d.generation?.attempt ?? 0) + 1, at: now(), feedback: feedback.trim(),
      files: files.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.content) })).sort((a, b) => a.path.localeCompare(b.path)),
      checks: checkBuild(d, files), usage: String(raw?.usage ?? "").slice(0, 4000),
    };
    d.tests = null; // new files: earlier results no longer apply
  });
}

// ---------- 4. tests (in the sandbox) ----------

export function runDraftTests(db: DB, id: string) {
  return step(id, "tests", async (d, report) => {
    if (!d.generation) throw invalid("Generate the component first.");
    if (!d.generation.checks.ok) throw invalid(`The safety checks found problems, so its code will not be run: ${d.generation.checks.problems.join(" ")}`);
    report("Running tests in the sandbox…");
    const t0 = Date.now();
    const at = now();
    const result = await runShell(sandboxedPythonTestCommand(), buildDir(d), getSettings(db).testTimeoutSeconds * 1000);
    d.tests = { ...result, at, durationMs: Date.now() - t0, filesChecksum: buildChecksum(d) };
  });
}

// ---------- 5. register and release ----------

/**
 * Copies the tested files into the library with the existing packaging, runs
 * the same sandboxed tests on that copy, and records release 1.0.0 with the
 * existing release code, which refuses anything whose latest run did not pass.
 */
export function registerAndRelease(db: DB, id: string) {
  return step(id, "register", async (d, report) => {
    if (d.component) throw invalid("It is already in the library.");
    if (stageOf(d) !== "tested") throw invalid("Its tests have not passed on these exact files. Run the tests first; it is never registered without passing them.");
    const blockers = readyToGenerate(db, d).filter((p) => !p.startsWith("There is no proposal"));
    if (blockers.length) throw invalid(blockers.join(" "));
    const category = getCategory(db, d.choice.category); // exactly one, and it exists
    const p = d.proposal!;
    const slug = slugOf(d);
    const releasePath = path.join(releasesDir(), slug, "1.0.0", slug);
    report("Copying into the library…");
    const { component } = registerPackagedComponent(db, {
      name: d.choice.name, slug, category: category.id, summary: d.choice.summary, language: "Python", version: "",
      sources: [buildDir(d)],
      capabilities: p.capabilities.map((c) => ({ ...c, kind: "capability" as const })),
      inputs: p.inputs, outputs: p.outputs,
      dependencies: [{ type: "system", name: "python3", version: ">=3.9 (standard library only)" }],
      testCommand: sandboxedPythonTestCommand(),
      documentation: `${d.generation!.usage}\n\nUse the released copy: add ${releasePath} to sys.path, then import ${packageOf(d)}.\n\nCreated from this description: "${d.prompt}"`,
    });
    recordActivity(db, component.id, "created from a description");
    report("Running tests on the library copy…");
    const run = await runComponentTests(db, component.id);
    if (run.status !== "passed")
      throw new LibraryError("VALIDATION", `"${component.name}" was added to the library, but its tests ${run.status} on the library copy, so it was not released. See its Tests tab.`);
    report("Creating release 1.0.0…");
    createRelease(db, component.id, { version: "1.0.0", changes: `First release. Created from a description and tested in the sandbox: ${d.choice.summary}` });
    d.component = { slug, version: "1.0.0" };
  });
}

// ---------- for the proposal page ----------

export interface SimilarComponent {
  slug: string;
  name: string;
  categoryName: string;
  /** The component's own one-line description. */
  summary: string;
  verdict: "same" | "partial" | "different";
  covers: string;
  missing: string;
}

/**
 * What the library already has for this request: the Milestone 6 search
 * shortlists, the AI judges the job (word overlap alone over-matches long
 * descriptions). Plus any component with the same name.
 */
export function similarTo(db: DB, d: Draft): { components: SimilarComponent[]; sameName: string[] } {
  const components = (d.proposal?.existing ?? []).flatMap((e) => {
    try { const c = getComponent(db, e.slug); return [{ slug: c.slug, name: c.name, categoryName: c.categoryName, summary: c.summary, verdict: e.verdict, covers: e.covers, missing: e.missing }]; }
    catch { return []; } // removed since
  });
  const sameName = d.choice.name ? findDuplicates(db, { name: d.choice.name }).exact.map((c) => c.name) : [];
  return { components, sameName };
}

export function draftComponent(db: DB, d: Draft) {
  return d.component ? getComponent(db, d.component.slug) : null;
}
