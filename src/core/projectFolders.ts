import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db";
import { checkPath } from "./paths";
import { getSettings } from "./settings";
import { listProjects, type Project } from "./projects";

/**
 * Finding and reading existing project folders, for "Add existing project".
 * A web page can't see real folder paths, so the browsing happens here, on
 * this Mac: folder names only (never file contents), only inside the allowed
 * folders, hidden folders left out. Reading a project for suggestions opens
 * at most its package.json / pyproject.toml and the top of its README.
 * Nothing here writes anything.
 */

const SKIP = new Set(["node_modules", "__pycache__", "venv", ".venv", "dist", "build", "Library", "Applications"]);
const MARKERS: [string, string][] = [
  ["package.json", "Node.js"], ["pyproject.toml", "Python"], ["requirements.txt", "Python"], ["go.mod", "Go"], ["Cargo.toml", "Rust"],
  ["Gemfile", "Ruby"], ["composer.json", "PHP"], ["Package.swift", "Swift"], ["wp-config.php", "WordPress"], ["index.html", "Web page"],
];

export interface FolderEntry { name: string; path: string; looksLikeProject: boolean; registeredAs: string | null }
export interface FolderListing {
  /** null at the top level: the allowed folders themselves. */
  path: string | null;
  parent: string | null;
  folders: FolderEntry[];
  registeredAs: string | null;
}

const looksLikeProject = (dir: string) => MARKERS.some(([f]) => exists(path.join(dir, f))) || exists(path.join(dir, ".git")) || exists(path.join(dir, "README.md"));
const exists = (p: string) => { try { fs.accessSync(p); return true; } catch { return false; } };

export function listFolders(db: DB, at?: string): FolderListing {
  const roots = getSettings(db).allowedRoots;
  const registered = new Map(listProjects(db).map((p) => [p.path, p.name]));
  const entry = (p: string): FolderEntry => ({ name: path.basename(p) || p, path: p, looksLikeProject: looksLikeProject(p), registeredAs: registered.get(p) ?? null });
  if (!at?.trim()) return { path: null, parent: null, folders: roots.filter((r) => exists(r)).map(entry), registeredAs: null };
  const dir = checkPath(db, at, "directory").path; // must be inside an allowed folder
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { names = []; }
  const folders = names
    .filter((n) => !n.startsWith(".") && !SKIP.has(n))
    .map((n) => path.join(dir, n))
    .filter((p) => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } })
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { sensitivity: "base" }))
    .slice(0, 500)
    .map(entry);
  const up = path.dirname(dir);
  const parent = up !== dir && roots.some((r) => up === r || up.startsWith(r + path.sep)) ? up : null;
  return { path: dir, parent, folders, registeredAs: registered.get(dir) ?? null };
}

export interface FolderSuggestion {
  path: string;
  name: string;
  description: string;
  /** Where the suggestions came from, in plain words, each once. */
  sources: string[];
  technology: string[];
  git: boolean;
  /** This exact folder is already in the library. */
  duplicate: Project | null;
  /** Registered projects inside this folder, or a registered project that contains it. */
  overlaps: { project: Project; relation: "inside" | "contains" }[];
}

const titleCase = (s: string) => s.replace(/[-_.]+/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());

function readSmall(file: string, max = 64 * 1024): string | null {
  try { const st = fs.statSync(file); if (!st.isFile() || st.size > max) return null; return fs.readFileSync(file, "utf8"); } catch { return null; }
}

/** First real paragraph of a README: no headings, badges, images, HTML or code. */
function readmeIntro(text: string): string {
  const paras = text.replace(/```[\s\S]*?```/g, "").split(/\n\s*\n/).map((p) => p.trim())
    .filter((p) => p && !/^(#|!\[|\[!\[|<|>|\||-{3,}|={3,})/.test(p));
  const first = (paras[0] ?? "").replace(/\s+/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "");
  return first.length > 240 ? `${first.slice(0, 237).replace(/\s+\S*$/, "")}…` : first;
}

export function inspectFolder(db: DB, at: string): FolderSuggestion {
  const dir = checkPath(db, at, "directory").path;
  const sources: string[] = [];
  let name = "";
  let description = "";

  const pkg = readSmall(path.join(dir, "package.json"));
  if (pkg) try {
    const j = JSON.parse(pkg);
    if (typeof j.name === "string" && j.name.trim()) { name = titleCase(j.name.replace(/^@[^/]+\//, "")); sources.push("package.json"); }
    if (typeof j.description === "string" && j.description.trim()) { description = j.description.trim(); sources.push("package.json"); }
  } catch { /* not valid JSON: ignore it */ }
  const py = readSmall(path.join(dir, "pyproject.toml"));
  if (py) {
    const n = py.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
    const d = py.match(/^\s*description\s*=\s*["']([^"']+)["']/m)?.[1];
    if (!name && n) { name = titleCase(n); sources.push("pyproject.toml"); }
    if (!description && d) { description = d; sources.push("pyproject.toml"); }
  }
  if (!description) {
    const readme = ["README.md", "README", "readme.md", "README.txt"].map((f) => readSmall(path.join(dir, f))).find(Boolean);
    const intro = readme ? readmeIntro(readme) : "";
    if (intro) { description = intro; sources.push("the README"); }
  }
  if (!name) { name = titleCase(path.basename(dir)); sources.push("the folder name"); }

  const projects = listProjects(db);
  const overlaps = projects.flatMap((p): FolderSuggestion["overlaps"] =>
    p.path === dir ? [] : p.path.startsWith(dir + path.sep) ? [{ project: p, relation: "inside" }] : dir.startsWith(p.path + path.sep) ? [{ project: p, relation: "contains" }] : []);
  return {
    path: dir, name, description, sources: [...new Set(sources)],
    technology: [...new Set(MARKERS.filter(([f]) => exists(path.join(dir, f))).map(([, t]) => t))],
    git: exists(path.join(dir, ".git")),
    duplicate: projects.find((p) => p.path === dir) ?? null,
    overlaps,
  };
}
