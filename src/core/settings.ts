import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DB } from "./db";
import { invalid } from "./errors";

export interface Settings {
  /** Source paths and project folders must live under one of these. */
  allowedRoots: string[];
  /** Hard limit for a single test run, in seconds. */
  testTimeoutSeconds: number;
  /** Where "Create project" makes new project folders. Created when first needed; must be inside an allowed folder. */
  projectsRoot: string;
}

const defaults = (): Settings => ({
  allowedRoots: [os.homedir()],
  testTimeoutSeconds: 120,
  projectsRoot: path.join(os.homedir(), "Projects"),
});

export function getSettings(db: DB): Settings {
  const out = defaults();
  for (const row of db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[]) {
    if (row.key in out) (out as any)[row.key] = JSON.parse(row.value);
  }
  return out;
}

export function updateSettings(db: DB, patch: Partial<Settings>): Settings {
  const next = { ...getSettings(db), ...patch };

  if (!Array.isArray(next.allowedRoots) || next.allowedRoots.length === 0)
    throw invalid("At least one allowed folder is required.");
  next.allowedRoots = next.allowedRoots.map((raw) => {
    const expanded = raw.trim().replace(/^~(?=$|\/)/, os.homedir());
    if (!path.isAbsolute(expanded)) throw invalid(`Allowed folder must be an absolute path: "${raw}"`);
    const p = path.resolve(expanded);
    if (p === "/") throw invalid("The whole disk (/) cannot be an allowed folder.");
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw invalid(`Allowed folder does not exist: "${p}"`);
    return fs.realpathSync(p);
  });

  const pr = String(next.projectsRoot ?? "").trim().replace(/^~(?=$|\/)/, os.homedir());
  if (!path.isAbsolute(pr)) throw invalid(`The projects location must be an absolute path: "${next.projectsRoot}"`);
  if (path.resolve(pr) === "/") throw invalid("The whole disk (/) cannot be the projects location.");
  next.projectsRoot = path.resolve(pr);
  // Checked when it changes; "Create project" checks it again before creating anything.
  if (patch.projectsRoot !== undefined && !next.allowedRoots.some((r) => insideReal(next.projectsRoot, r)))
    throw invalid(`The projects location must be inside an allowed folder (${next.allowedRoots.join(", ")}).`);

  const t = Number(next.testTimeoutSeconds);
  if (!Number.isInteger(t) || t < 1 || t > 3600) throw invalid("Test timeout must be a whole number of seconds from 1 to 3600.");
  next.testTimeoutSeconds = t;

  const put = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  db.transaction(() => {
    for (const [k, v] of Object.entries(next)) put.run(k, JSON.stringify(v));
  })();
  return next;
}

/** Whether `p` is `root` or inside it, comparing real paths of the deepest part that exists. */
export function insideReal(p: string, root: string): boolean {
  let probe = path.resolve(p);
  const rest: string[] = [];
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) { rest.unshift(path.basename(probe)); probe = path.dirname(probe); }
  const real = path.join(fs.realpathSync(probe), ...rest);
  const r = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
  return real === r || real.startsWith(r + path.sep);
}

/** Folders that sync with iCloud on this Mac, where git and builds misbehave. */
export function iCloudWarning(p: string): string | null {
  const home = os.homedir();
  for (const synced of ["Desktop", "Documents"]) if (insideReal(p, path.join(home, synced)))
    return `${path.join(home, synced)} syncs with iCloud on this Mac, which can rename git files and offload project files. A folder like ~/Projects is safer.`;
  return null;
}
