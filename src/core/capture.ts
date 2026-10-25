import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db";
import { libraryCodeDir } from "./db";
import { LibraryError } from "./errors";
import { checkPath } from "./paths";
import { listCategories } from "./categories";
import { findDuplicates } from "./discovery";
import { excludedReason, findSecrets, planCopy, type Plan, type SecretFinding } from "./packaging";
import { listProjects, type Project } from "./projects";
import { releasesDir } from "./releases";
import { slugify, validSlug } from "./util";

/**
 * Capture proposals. Reads the candidate files and the library, and reports
 * the facts a person needs to decide whether to capture something: what would
 * be copied, what would be left out, what it reaches into, what it already
 * duplicates. It never writes anything. Claude adds the judgement (why it is
 * reusable, limitations) and shows the whole proposal before any change.
 */

export interface CaptureRequest {
  name: string;
  /** Absolute paths: the original code, or a separated copy prepared for capture. */
  sources: string[];
  slug?: string;
  category?: string;
  summary?: string;
  capabilities?: string[];
  /** The project the code comes from (id or path). Found from the source paths when omitted. */
  project?: string;
}

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|swift|kt|java|php|sh)$/;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|(^|\/)test_[^/]+\.py$|_test\.(py|go)$|\.(test|spec)\.[jt]sx?$/;
const DEP_FILES = ["package.json", "requirements.txt", "pyproject.toml", "setup.py", "setup.cfg", "Pipfile", "go.mod", "Cargo.toml", "Gemfile", "Package.swift"];
const DATA_EXT = /\.(csv|tsv|xlsx|xls|jsonl|ndjson|parquet)$/;
const TRIVIAL_LINES = 30;

export interface CaptureProposal {
  changed: false;
  name: string;
  slug: string;
  category: { requested: string | null; match: { slug: string; name: string } | null; existing: string[] };
  duplicates: ReturnType<typeof findDuplicates>;
  files: {
    included: string[];
    count: number;
    bytes: number;
    codeLines: number;
    excluded: { path: string; reason: string }[];
    secrets: SecretFinding[];
    dataFiles: string[];
  };
  tests: { files: string[]; note: string };
  dependencies: { manifests: string[]; imports: string[] };
  /** What the code reaches outside the copied files: these must be separated, or the component will not run alone. */
  reachesOutside: { file: string; line: number; import: string }[];
  configuration: string[];
  sourceProject:
    | { registered: true; id: string; name: string; path: string }
    | { registered: false; suggestedPath: string | null; note: string };
  destination: { folder: string; firstRelease: string };
  signals: string[];
  blockers: string[];
  present: string[];
}

export function proposeCapture(db: DB, req: CaptureRequest): CaptureProposal {
  if (!req.sources?.length) throw new LibraryError("VALIDATION", "Give at least one source path to propose a capture.");
  const sources = req.sources.map((s) => checkPath(db, s));
  const slug = req.slug?.trim() ? validSlug(req.slug) : validSlug(slugify(req.name), "Slug (made from the name)");

  // The same walk packaging uses, so the proposal lists exactly what a capture would copy.
  const plan: Plan[] = [];
  const skipped: string[] = [];
  for (const s of sources) planCopy(s.path, path.join(libraryCodeDir(), slug, path.basename(s.path)), plan, skipped);
  const rel = (f: string) => {
    const owner = sources.find((s) => f === s.path || f.startsWith(s.path + path.sep));
    return owner ? path.join(path.basename(owner.path), path.relative(owner.path, f)).replace(/\/$/, "") || path.basename(f) : f;
  };
  const included = plan.map((p) => rel(p.from));
  const excluded = skipped.map((f) => ({
    path: rel(f),
    reason: fs.lstatSync(f).isSymbolicLink() ? "symbolic link" : fs.lstatSync(f).isDirectory() ? "dependencies, build output or tool folder" : excludedReason(path.basename(f)) ?? "excluded",
  }));
  const bytes = plan.reduce((n, p) => n + fs.statSync(p.from).size, 0);
  const secrets = findSecrets(plan.map((p) => p.from)).map((f) => ({ ...f, file: rel(f.file) }));

  const code = plan.filter((p) => CODE_EXT.test(p.from));
  const texts = new Map(code.map((p) => [p.from, fs.statSync(p.from).size < 1024 * 1024 ? fs.readFileSync(p.from, "utf8") : ""]));
  const codeLines = [...texts.values()].reduce((n, t) => n + t.split("\n").filter((l) => l.trim() && !/^\s*(#|\/\/)/.test(l)).length, 0);

  const project = findProject(db, sources.map((s) => s.path), req.project);
  const { reachesOutside, imports } = scanImports(texts, sources.map((s) => s.path), project && "path" in project ? project.path : null);
  const configuration = [...new Set([...texts.values()].flatMap((t) =>
    [...t.matchAll(/process\.env\.([A-Z0-9_]+)|process\.env\[["']([A-Z0-9_]+)["']\]|os\.environ(?:\.get)?\(?\[?["']([A-Z0-9_]+)["']|os\.getenv\(["']([A-Z0-9_]+)["']/g)]
      .map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]),
  ))].sort();

  const cats = listCategories(db);
  const want = req.category?.trim().toLowerCase();
  const catMatch = want ? cats.find((c) => c.slug === want || c.id === want || c.name.toLowerCase() === want) ?? null : null;
  const duplicates = findDuplicates(db, { name: req.name, summary: req.summary, capabilities: req.capabilities });

  const testFiles = included.filter((f) => TEST_FILE.test(f));
  const manifests = included.filter((f) => DEP_FILES.includes(path.basename(f)));
  const dataFiles = included.filter((f) => DATA_EXT.test(f));
  const folder = path.join(libraryCodeDir(), slug);
  const slugTaken = (db.prepare("SELECT name FROM components WHERE slug = ?").get(slug) as { name: string } | undefined)?.name;

  const signals: string[] = [];
  if (codeLines < TRIVIAL_LINES) signals.push(`Small: ${codeLines} lines of code. Probably too small to be worth a component unless it is hard to get right.`);
  if (reachesOutside.length) signals.push(`Tied to its application: ${reachesOutside.length} import(s) reach code that would not be copied. Separate those, or it will not run on its own.`);
  if (configuration.length) signals.push(`Reads configuration: ${configuration.join(", ")}. Document each one; never copy the values.`);
  if (!testFiles.length) signals.push("No tests found in the files to copy. Add meaningful tests before releasing.");
  if (dataFiles.length) signals.push(`Data files would be copied: ${dataFiles.join(", ")}. Make sure none is a personal or customer dataset.`);
  if (!code.length) signals.push("No code files found.");

  const blockers: string[] = [];
  if (duplicates.verdict === "exact") blockers.push(`Already in the library: ${duplicates.exact.map((c) => c.slug).join(", ") || duplicates.similar.filter((m) => m.strength === "strong").map((m) => m.component.slug).join(", ")}. Reuse or extend it instead.`);
  if (slugTaken) blockers.push(`The slug "${slug}" is already used by "${slugTaken}". Pick another name or slug.`);
  if (fs.existsSync(folder)) blockers.push(`The folder ${folder} already exists.`);
  if (secrets.length) blockers.push(`${secrets.length} line(s) look like credentials; nothing will be copied until they are removed.`);
  if (!plan.length) blockers.push("Every file would be excluded, so there is nothing to copy.");
  if (want && !catMatch) blockers.push(`There is no category "${req.category}". Pick one of the existing categories, or create it first (create_category asks for approval).`);

  return {
    changed: false,
    name: req.name,
    slug,
    category: { requested: req.category ?? null, match: catMatch ? { slug: catMatch.slug, name: catMatch.name } : null, existing: cats.map((c) => c.slug) },
    duplicates,
    files: { included, count: plan.length, bytes, codeLines, excluded, secrets, dataFiles },
    tests: {
      files: testFiles,
      note: testFiles.length ? "Run them in the copied folder before releasing (run_component_tests asks for approval)." : "None found.",
    },
    dependencies: { manifests, imports },
    reachesOutside,
    configuration,
    sourceProject: project,
    destination: { folder, firstRelease: path.join(releasesDir(), slug, "1.0.0") },
    signals,
    blockers,
    present: [
      "Suggested name and category", "What it does", "Why it is reusable", "Files included (and excluded)", "Dependencies",
      "Inputs and outputs", "Existing tests", "What must be separated from the original project", "Limitations and risks",
    ],
  };
}

/** The registered project the sources live in, or a suggestion for which folder to register. */
function findProject(db: DB, sources: string[], ref?: string): CaptureProposal["sourceProject"] {
  const projects = listProjects(db);
  const inside = (p: Project) => sources.every((s) => s === p.path || s.startsWith(p.path + path.sep));
  const named = ref ? projects.find((p) => p.id === ref || p.path === ref) : undefined;
  if (ref && !named) throw new LibraryError("NOT_FOUND", `No registered project "${ref}".`);
  const hit = named ?? projects.filter(inside).sort((a, b) => b.path.length - a.path.length)[0];
  if (hit) return { registered: true, id: hit.id, name: hit.name, path: hit.path };
  // Suggest the nearest folder above the sources that looks like a project root.
  let dir = fs.statSync(sources[0]).isDirectory() ? sources[0] : path.dirname(sources[0]);
  for (let i = 0; i < 8 && dir !== path.dirname(dir); i++, dir = path.dirname(dir))
    if (["package.json", "pyproject.toml", ".git", "requirements.txt"].some((m) => fs.existsSync(path.join(dir, m))))
      return { registered: false, suggestedPath: dir, note: `Not a registered project. Offer to register ${dir} (register_project asks for approval) so the library can record where this came from.` };
  return { registered: false, suggestedPath: null, note: "Not inside a registered project." };
}

/** Imports that leave the copied files, and the external packages the code names. */
function scanImports(texts: Map<string, string>, sources: string[], projectRoot: string | null) {
  const within = (f: string) => sources.some((s) => f === s || f.startsWith(s + path.sep));
  const reachesOutside: { file: string; line: number; import: string }[] = [];
  const imports = new Set<string>();
  // Names that resolve to the copied files themselves: the source folders, and every module and folder inside them.
  const localTop = new Set(sources.map((s) => path.basename(s).replace(/\.(py|ts|js)$/, "")));
  for (const f of texts.keys())
    for (let d = f; within(d); d = path.dirname(d)) localTop.add(path.basename(d).replace(/\.(py|ts|js)$/, ""));
  // Top-level folders of the project that would not be copied: importing them means reaching into the app.
  const appTop = new Set(projectRoot ? fs.readdirSync(projectRoot).filter((n) => !n.startsWith(".")).map((n) => n.replace(/\.py$/, "")) : []);

  for (const [file, text] of texts) {
    const isPy = file.endsWith(".py");
    text.split("\n").forEach((raw, i) => {
      const line = isPy ? raw.replace(/\s+#.*$/, "") : raw.replace(/\s+\/\/.*$/, "");
      const flag = (spec: string) => reachesOutside.push({ file, line: i + 1, import: spec });
      if (isPy) {
        const rel = line.match(/^\s*from\s+(\.+)([\w.]*)\s+import/);
        if (rel) {
          let dir = path.dirname(file);
          for (let k = 1; k < rel[1].length; k++) dir = path.dirname(dir);
          if (!within(dir)) flag(line.trim());
          return;
        }
        const abs = line.match(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/);
        if (abs) {
          const top = (abs[1] ?? abs[2]).split(".")[0];
          if (localTop.has(top)) return;
          if (appTop.has(top)) flag(line.trim());
          else imports.add(top);
        }
        return;
      }
      for (const m of line.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|^\s*import\s+)["']([^"']+)["']/g)) {
        const spec = m[1];
        if (spec.startsWith(".")) {
          const target = path.resolve(path.dirname(file), spec);
          if (!within(target)) flag(spec);
        } else if (spec.startsWith("@/") || spec.startsWith("~/")) flag(spec);
        else if (!spec.startsWith("node:")) imports.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
      }
    });
  }
  return { reachesOutside: reachesOutside.map((r) => ({ ...r, file: path.basename(path.dirname(r.file)) + "/" + path.basename(r.file) })), imports: [...imports].sort() };
}
