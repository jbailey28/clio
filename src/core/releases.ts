import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db";
import { libraryCodeDir } from "./db";
import { LibraryError, invalid, notFound } from "./errors";
import { checkPath } from "./paths";
import { getComponent, recordActivity } from "./components";
import { getCategory } from "./categories";
import { findSecrets, planCopy, secretsError, type Plan } from "./packaging";
import { newId, now, optionalText, validSlug } from "./util";
import { compareVersions, parseVersion } from "./semver";

export { compareVersions, parseVersion } from "./semver";

/**
 * Releases: a version number, a frozen copy of the source, a checksum of that
 * copy, and notes on what changed. Recording a release never changes which
 * version a project uses; that only changes when someone sets it.
 */

export interface Release {
  id: string;
  componentId: string;
  version: string;
  sourcePath: string;
  checksum: string;
  fileCount: number;
  changes: string;
  gitTag: string;
  releasedAt: string;
}

export interface ReleaseCheck {
  version: string;
  sourcePath: string;
  /** intact = files match the recorded checksum; changed = they don't; missing = folder gone. */
  state: "intact" | "changed" | "missing";
  recorded: string;
  actual: string | null;
}

// ---------- checksums ----------

export const MANIFEST = "RELEASE.json";

/** sha256 of every file (except the manifest), keyed by relative path, sorted. */
export function treeChecksum(dir: string): { checksum: string; files: { path: string; sha256: string }[] } {
  const files: { path: string; sha256: string }[] = [];
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) throw new LibraryError("VALIDATION", `Releases can't contain symlinks: ${full}`);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        const rel = path.relative(dir, full);
        if (rel === MANIFEST) continue;
        files.push({ path: rel, sha256: crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex") });
      }
    }
  };
  walk(dir);
  const checksum = crypto.createHash("sha256").update(files.map((f) => `${f.sha256}  ${f.path}\n`).join("")).digest("hex");
  return { checksum, files };
}

export function releasesDir(): string {
  return path.join(libraryCodeDir(), "releases");
}

/**
 * Copies a component's source folder into releases/<slug>/<version>/, writes
 * RELEASE.json with every file's checksum, and makes the copy read-only.
 * Refuses to overwrite an existing release.
 */
export function snapshotRelease(db: DB, input: { slug: string; version: string; from: string }) {
  const slug = validSlug(input.slug);
  parseVersion(input.version);
  const from = checkPath(db, input.from, "directory").path;
  const root = releasesDir();
  fs.mkdirSync(path.join(root, slug), { recursive: true });
  const dest = path.join(root, slug, input.version);
  if (fs.existsSync(dest)) throw new LibraryError("CONFLICT", `Release ${slug} ${input.version} already exists at ${dest}. Releases are never overwritten.`);
  if (dest.startsWith(from + path.sep)) throw invalid("The release folder can't be inside the folder being released.");

  const plan: Plan[] = [];
  const skipped: string[] = [];
  planCopy(from, dest, plan, skipped);
  if (!plan.length) throw invalid(`Nothing to release in ${from}.`);
  const secrets = findSecrets(plan.map((p) => p.from));
  if (secrets.length) throw secretsError(secrets);
  fs.mkdirSync(dest);
  try {
    for (const p of plan) {
      fs.mkdirSync(path.dirname(p.to), { recursive: true });
      fs.copyFileSync(p.from, p.to, fs.constants.COPYFILE_EXCL);
    }
    const { checksum, files } = treeChecksum(dest);
    fs.writeFileSync(path.join(dest, MANIFEST), JSON.stringify({ component: slug, version: input.version, copiedFrom: from, createdAt: now(), checksum, files }, null, 2) + "\n");
    lockTree(dest);
    return { path: dest, checksum, files, skipped };
  } catch (err) {
    unlockTree(dest);
    fs.rmSync(dest, { recursive: true, force: true }); // only the folder created above
    throw err;
  }
}

/** Read-only files and folders, so an accidental edit fails instead of silently changing a release. */
export function lockTree(dir: string) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.lstatSync(full);
    if (st.isDirectory()) lockTree(full);
    else fs.chmodSync(full, st.mode & 0o555); // drop write only; an executable stays executable
  }
  fs.chmodSync(dir, 0o555);
}

export function unlockTree(dir: string) {
  if (!fs.existsSync(dir)) return;
  fs.chmodSync(dir, 0o755);
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.lstatSync(full);
    if (st.isDirectory()) unlockTree(full);
    else fs.chmodSync(full, (st.mode & 0o777) | 0o200);
  }
}

/** No release without a valid category. The database already requires one; this says so plainly if it is ever missing. */
function requireCategory(db: DB, categoryId: string, name: string) {
  try { getCategory(db, categoryId); }
  catch { throw new LibraryError("VALIDATION", `"${name}" has no valid category, so it can't be released. Give it a category first.`); }
}

// ---------- records ----------

const SELECT = `SELECT id, component_id AS componentId, version, source_path AS sourcePath, checksum, file_count AS fileCount,
                       changes, git_tag AS gitTag, released_at AS releasedAt FROM component_releases`;

/** Newest version first. */
export function listReleases(db: DB, componentRef: string): Release[] {
  const c = getComponent(db, componentRef);
  const rows = db.prepare(`${SELECT} WHERE component_id = ?`).all(c.id) as Release[];
  return rows.sort((a, b) => compareVersions(b.version, a.version));
}

export function latestRelease(db: DB, componentId: string): Release | null {
  return listReleases(db, componentId)[0] ?? null;
}

export function getRelease(db: DB, componentRef: string, version: string): Release {
  const r = listReleases(db, componentRef).find((x) => x.version === version.trim());
  if (!r) throw notFound("Release", `${componentRef} ${version}`);
  return r;
}

/**
 * Records a release that already exists on disk. The folder's checksum is
 * computed now; if it has a RELEASE.json, the two must agree, so a copy that
 * changed after it was made can't be recorded as that release.
 */
export function recordRelease(db: DB, componentRef: string, input: { version: string; path: string; changes: string; gitTag?: string }): Release {
  const c = getComponent(db, componentRef);
  requireCategory(db, c.categoryId, c.name);
  const version = input.version.trim();
  parseVersion(version);
  const changes = optionalText(input.changes, "Change notes", 20000);
  if (!changes) throw invalid("Change notes are required: say what is different in this version.");
  const existing = listReleases(db, c.id);
  if (existing.some((r) => r.version === version)) throw new LibraryError("CONFLICT", `${c.name} ${version} is already recorded.`);
  if (existing.length && compareVersions(version, existing[0].version) <= 0)
    throw invalid(`${version} must be newer than the latest release, ${existing[0].version}.`);
  const dir = checkPath(db, input.path, "directory").path;
  const { checksum, files } = treeChecksum(dir);
  const manifestPath = path.join(dir, MANIFEST);
  if (fs.existsSync(manifestPath)) {
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (m.checksum !== checksum)
      throw new LibraryError("VALIDATION", `The files in ${dir} no longer match its ${MANIFEST} (recorded ${String(m.checksum).slice(0, 12)}…, now ${checksum.slice(0, 12)}…). Not recording a changed release.`);
    if (m.version && m.version !== version) throw invalid(`${MANIFEST} says version ${m.version}, not ${version}.`);
  }
  const row: Release = {
    id: newId("rel"), componentId: c.id, version, sourcePath: dir, checksum, fileCount: files.length,
    changes, gitTag: optionalText(input.gitTag, "Git tag", 200), releasedAt: now(),
  };
  db.transaction(() => {
    db.prepare(`INSERT INTO component_releases (id, component_id, version, source_path, checksum, file_count, changes, git_tag, released_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.componentId, row.version, row.sourcePath, row.checksum, row.fileCount, row.changes, row.gitTag, row.releasedAt);
    // The component's version is its newest release. Project links are deliberately not touched.
    if (!existing.length || compareVersions(version, existing[0].version) > 0)
      db.prepare("UPDATE components SET version = ?, updated_at = ? WHERE id = ?").run(version, now(), c.id);
    recordActivity(db, c.id, `released ${version}`);
  })();
  return row;
}

export function verifyRelease(db: DB, componentRef: string, version: string): ReleaseCheck {
  const r = getRelease(db, componentRef, version);
  if (!fs.existsSync(r.sourcePath)) return { version: r.version, sourcePath: r.sourcePath, state: "missing", recorded: r.checksum, actual: null };
  const actual = treeChecksum(r.sourcePath).checksum;
  return { version: r.version, sourcePath: r.sourcePath, state: actual === r.checksum ? "intact" : "changed", recorded: r.checksum, actual };
}

/** Releases after `from`, up to and including `to` (default: the latest), oldest first. */
export function changesBetween(db: DB, componentRef: string, from: string, to?: string): Release[] {
  const all = listReleases(db, componentRef);
  parseVersion(from);
  if (!all.some((r) => r.version === from)) throw notFound("Release", `${componentRef} ${from}`);
  const target = to ?? all[0]?.version;
  if (target) {
    parseVersion(target);
    if (!all.some((r) => r.version === target)) throw notFound("Release", `${componentRef} ${target}`);
  }
  return all
    .filter((r) => compareVersions(r.version, from) > 0 && (!target || compareVersions(r.version, target) <= 0))
    .sort((a, b) => compareVersions(a.version, b.version));
}

/** Where a project stands: the version it records, the newest release, and whether that is newer. */
export function versionStatus(db: DB, componentId: string, usedVersion: string) {
  const latest = latestRelease(db, componentId);
  const latestVersion = latest?.version ?? "";
  let upgradeAvailable = false;
  if (usedVersion && latestVersion) {
    try { upgradeAvailable = compareVersions(latestVersion, usedVersion) > 0; } catch { upgradeAvailable = false; }
  }
  return { usedVersion, latestVersion, upgradeAvailable };
}

// ---------- one-step release (snapshot + record) ----------

/**
 * The folder a release copies: a packaged component's whole shared folder
 * (library/<slug>, when every source lives inside it), else its primary
 * source folder.
 */
export function releaseSource(db: DB, componentRef: string): string {
  const c = getComponent(db, componentRef);
  const pkg = path.join(libraryCodeDir(), c.slug);
  if (c.sources.length && c.sources.every((s) => s.path === pkg || s.path.startsWith(pkg + path.sep))) return pkg;
  const primary = c.sources.find((s) => s.isPrimary) ?? c.sources[0];
  if (!primary || primary.kind !== "directory")
    throw invalid(`${c.name}'s primary source is not a folder, so there is no folder to release. Make a release folder with scripts/release.ts and record it with record_release.`);
  return primary.path;
}

export interface ReleaseReadiness {
  from: string;
  ready: boolean;
  /** Why it is not ready, in plain words. Empty when ready. */
  problems: string[];
  lastRun: { status: string; startedAt: string } | null;
}

/**
 * A release is only made from files that passed their tests as they are now:
 * the latest test run passed, and no file in the folder changed after it started.
 */
export function releaseReadiness(db: DB, componentRef: string): ReleaseReadiness {
  const c = getComponent(db, componentRef);
  const from = releaseSource(db, c.id);
  const run = db.prepare("SELECT status, started_at AS startedAt FROM test_runs WHERE component_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(c.id) as { status: string; startedAt: string } | undefined;
  const problems: string[] = [];
  if (!c.testCommand.trim()) problems.push("It has no test command, so there is no evidence it works.");
  else if (!run) problems.push("Its tests have never been run. Run them first (run_component_tests asks for approval).");
  else if (run.status !== "passed") problems.push(`The latest test run ${run.status} (${run.startedAt}). Fix it and run the tests again.`);
  if (run) {
    const plan: Plan[] = [];
    planCopy(from, from, plan, []);
    const started = Date.parse(run.startedAt);
    // File times have sub-millisecond precision; the start time doesn't.
    const newer = plan.filter((p) => Math.floor(fs.statSync(p.from).mtimeMs) > started).map((p) => path.relative(from, p.from));
    if (newer.length) problems.push(`${newer.length} file(s) changed after the last test run (${newer.slice(0, 5).join(", ")}). Run the tests again.`);
  }
  return { from, ready: problems.length === 0, problems, lastRun: run ?? null };
}

/**
 * Freezes the component's folder as `version` and records it, in one step.
 * If recording fails, the frozen copy made here is removed again.
 */
export function createRelease(db: DB, componentRef: string, input: { version: string; changes: string; gitTag?: string }) {
  const c = getComponent(db, componentRef);
  requireCategory(db, c.categoryId, c.name);
  const ready = releaseReadiness(db, c.id);
  if (!ready.ready) throw new LibraryError("VALIDATION", `Not released: ${ready.problems.join(" ")}`);
  const version = input.version.trim();
  parseVersion(version);
  const latest = listReleases(db, c.id)[0];
  if (latest && compareVersions(version, latest.version) <= 0) throw invalid(`${version} must be newer than the latest release, ${latest.version}.`);
  if (!optionalText(input.changes, "Change notes", 20000)) throw invalid("Change notes are required: say what is in this version.");
  const snap = snapshotRelease(db, { slug: c.slug, version, from: ready.from });
  try {
    const release = recordRelease(db, c.id, { version, path: snap.path, changes: input.changes, gitTag: input.gitTag });
    return { release, files: snap.files.length, skipped: snap.skipped };
  } catch (err) {
    unlockTree(snap.path);
    fs.rmSync(snap.path, { recursive: true, force: true }); // only the copy made above
    throw err;
  }
}
