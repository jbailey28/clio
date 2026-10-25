import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db";
import { libraryCodeDir } from "./db";
import { LibraryError } from "./errors";
import { checkPath } from "./paths";
import { createComponent, getComponent, recordActivity, setOrigin, type ComponentDetail, type ComponentInput } from "./components";
import { getProject } from "./projects";
import { slugify, validSlug } from "./util";

/** Never copied: dependencies, build output, version control, and anything that looks like secrets or private data. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".next-test", "dist", "build", ".turbo", ".cache", "coverage", "__pycache__", ".venv", "venv",
  ".pytest_cache", ".mypy_cache", ".ruff_cache", ".idea", ".vscode", ".ssh", ".aws", ".gnupg",
]);
/** Why a file is never copied, or null to copy it. Matched on the name alone, so the file is never opened. */
export function excludedReason(name: string): string | null {
  const n = name.toLowerCase();
  if (n === ".ds_store") return "system file";
  if (n.startsWith(".env") || n.endsWith(".env")) return "environment file (may hold secrets)";
  if (/\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|asc|gpg|ovpn|kdbx)$/.test(n)) return "key or certificate";
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(n)) return "SSH key";
  if ([".npmrc", ".pypirc", ".netrc", ".pgpass", ".htpasswd", ".git-credentials"].includes(n)) return "credentials file";
  // Data and config files only: a code file named token.ts is ordinary code, and its contents are scanned anyway.
  const dataFile = !/\./.test(n.replace(/^\./, "")) || /\.(json|ya?ml|toml|ini|cfg|conf|txt|properties|plist|xml)$/.test(n);
  if (dataFile && (/(^|[._-])(secret|secrets|credential|credentials|token|tokens|webhook|webhooks|apikey|api_key|api-key|password|passwords)([._-]|$)/.test(n) || /service[-_]?account/.test(n))) return "name suggests secrets";
  if (/\.(db|sqlite|sqlite3|db-wal|db-shm|sqlite-wal|sqlite-shm)$/.test(n)) return "database (may hold personal data)";
  if (/\.(log)$/.test(n)) return "log file";
  return null;
}
const SKIP_FILE = (name: string) => excludedReason(name) !== null;

/** Text that looks like a real credential. A match blocks the copy; the file is not silently dropped, because it may be code that is needed. */
const SECRET_PATTERNS: { label: string; re: RegExp }[] = [
  { label: "private key", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { label: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { label: "OpenAI-style API key", re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/ },
  { label: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/ },
  { label: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { label: "Stripe live key", re: /\b[sr]k_live_[A-Za-z0-9]{20,}/ },
  { label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: "webhook URL (works like a password)", re: /https:\/\/(?:(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]{20,}|hooks\.slack\.com\/(?:services|workflows|triggers)\/[\w/-]{20,}|[\w-]+\.webhook\.office\.com\/[\w/@-]{20,})/ },
  { label: "password or key written into the code", re: /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token)\b["']?\s*[:=]\s*["'][^"'\s$<{]{12,}["']/i },
];

export interface SecretFinding { file: string; line: number; label: string }

/** Scans the files that would be copied. Skips files over 1 MB and binary files (any NUL byte). */
export function findSecrets(files: string[]): SecretFinding[] {
  const found: SecretFinding[] = [];
  for (const file of files) {
    if (fs.statSync(file).size > 1024 * 1024) continue;
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) continue;
    const lines = buf.toString("utf8").split("\n");
    lines.forEach((text, i) => {
      for (const p of SECRET_PATTERNS) if (p.re.test(text)) { found.push({ file, line: i + 1, label: p.label }); break; }
    });
  }
  return found;
}

export function secretsError(found: SecretFinding[]): LibraryError {
  const list = found.slice(0, 10).map((f) => `${f.file}:${f.line} (${f.label})`).join("; ");
  return new LibraryError("VALIDATION", `Nothing was copied: ${found.length} line(s) look like credentials: ${list}. Remove them (read them from configuration instead) and try again.`);
}
const MAX_FILES = 500;
const MAX_BYTES = 10 * 1024 * 1024;

export interface Plan { from: string; to: string }

export function planCopy(src: string, dest: string, plan: Plan[], skipped: string[]) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) { skipped.push(src); return; }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(src).sort()) {
      const child = path.join(src, name);
      const cst = fs.lstatSync(child);
      if (cst.isDirectory() && SKIP_DIRS.has(name)) { skipped.push(child); continue; }
      if (cst.isFile() && SKIP_FILE(name)) { skipped.push(child); continue; }
      planCopy(child, path.join(dest, name), plan, skipped);
    }
  } else if (st.isFile()) {
    if (SKIP_FILE(path.basename(src))) { skipped.push(src); return; }
    plan.push({ from: src, to: dest });
  }
}

export interface PackageResult {
  folder: string;
  paths: string[];
  filesCopied: number;
  bytesCopied: number;
  skipped: string[];
}

/**
 * Copies source files into the shared code folder at <library>/<slug>/.
 * Reads the originals only; never changes or removes them. Refuses to
 * overwrite, and checks every limit before writing anything.
 */
export function packageSources(db: DB, slug: string, sources: string[]): PackageResult {
  validSlug(slug);
  if (!sources.length) throw new LibraryError("VALIDATION", "At least one source path is required to package.");
  const root = libraryCodeDir();
  fs.mkdirSync(root, { recursive: true });
  checkPath(db, root, "directory"); // the shared folder itself must be inside the allowed folders
  const folder = path.join(root, slug);
  if (fs.existsSync(folder))
    throw new LibraryError("CONFLICT", `The shared folder "${folder}" already exists. Pick another slug, or register that folder directly.`);

  const checked = sources.map((s) => checkPath(db, s));
  const names = checked.map((c) => path.basename(c.path));
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new LibraryError("VALIDATION", `Two sources are both named "${dup}". Package them separately or rename one.`);
  for (const c of checked)
    if (c.path === root || c.path.startsWith(root + path.sep) || root.startsWith(c.path + path.sep))
      throw new LibraryError("VALIDATION", `"${c.path}" overlaps the shared code folder; register it directly instead of packaging.`);

  const plan: Plan[] = [];
  const skipped: string[] = [];
  checked.forEach((c, i) => planCopy(c.path, path.join(folder, names[i]), plan, skipped));
  if (!plan.length) throw new LibraryError("VALIDATION", "Nothing to copy: every file was excluded (dependencies, build output, secrets).");
  if (plan.length > MAX_FILES) throw new LibraryError("VALIDATION", `Too many files to package (${plan.length}, limit ${MAX_FILES}). Point at a smaller folder.`);
  const bytes = plan.reduce((n, p) => n + fs.statSync(p.from).size, 0);
  if (bytes > MAX_BYTES) throw new LibraryError("VALIDATION", `Too much to package (${(bytes / 1048576).toFixed(1)} MB, limit 10 MB).`);
  const secrets = findSecrets(plan.map((p) => p.from));
  if (secrets.length) throw secretsError(secrets);

  fs.mkdirSync(folder);
  try {
    for (const p of plan) {
      fs.mkdirSync(path.dirname(p.to), { recursive: true });
      fs.copyFileSync(p.from, p.to, fs.constants.COPYFILE_EXCL);
    }
  } catch (err) {
    fs.rmSync(folder, { recursive: true, force: true }); // only the folder created above
    throw err;
  }
  return { folder, paths: names.map((n) => path.join(folder, n)), filesCopied: plan.length, bytesCopied: bytes, skipped };
}

export interface OriginInput {
  /** Registered project (id or path) the code was extracted from. */
  project?: string;
  /** The original files in that project, when the sources are a separated copy. Defaults to the sources. */
  paths?: string[];
}

/** Checks an origin before anything is copied: the project exists and every original path sits inside it. */
export function resolveOrigin(db: DB, sources: string[], origin?: OriginInput): { projectId: string | null; paths: string[] } | null {
  if (!origin || (!origin.project && !origin.paths?.length)) return null;
  const paths = (origin.paths?.length ? origin.paths : sources).map((p) => checkPath(db, p).path);
  if (!origin.project) return { projectId: null, paths };
  const p = getProject(db, origin.project);
  const outside = paths.filter((x) => x !== p.path && !x.startsWith(p.path + path.sep));
  if (outside.length) throw new LibraryError("VALIDATION", `These original paths are not inside "${p.name}" (${p.path}): ${outside.join(", ")}.`);
  return { projectId: p.id, paths };
}

/**
 * Packages the sources, then registers the component pointing at the copies,
 * and records where they came from. Undoes the copy if registering fails.
 * The originals are only read.
 */
export function registerPackagedComponent(db: DB, input: ComponentInput, originInput?: OriginInput): { component: ComponentDetail; packaged: PackageResult } {
  const slug = input.slug?.trim() || slugify(input.name ?? "");
  const origin = resolveOrigin(db, input.sources, originInput);
  const packaged = packageSources(db, slug, input.sources);
  try {
    // With several sources, tests run from the shared folder that holds them all.
    const testCwd = input.testCwd?.trim() ? input.testCwd : packaged.paths.length > 1 ? packaged.folder : undefined;
    let component = db.transaction(() => {
      const c = createComponent(db, { ...input, slug, sources: packaged.paths, testCwd });
      return origin ? setOrigin(db, c.id, origin) : c;
    })();
    if (origin) recordActivity(db, component.id, `captured from ${origin.paths[0]}`);
    component = getComponent(db, component.id);
    return { component, packaged };
  } catch (err) {
    fs.rmSync(packaged.folder, { recursive: true, force: true });
    throw err;
  }
}
