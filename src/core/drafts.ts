import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./db";
import { LibraryError, notFound } from "./errors";
import { now } from "./util";

/**
 * Drafts: work in progress kept as files, one folder per draft in
 * <data>/staging/<id>/ (draft.json plus whatever the draft builds). Used by
 * component creation (drf_) and project creation (pdr_). Refreshing or
 * leaving keeps a draft; one step runs at a time; each step records what it is
 * doing so the page can show real progress.
 */

export interface DraftBase {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** The step running now, and what it is doing. Written by the server as it reaches each part, never guessed. */
  busy: { step: string; since: string; detail?: string } | null;
  lastError: { step: string; message: string; at: string } | null;
}

export type Report = (detail: string) => void;

export function stagingRoot(): string {
  return path.join(dataDir(), "staging");
}

// A step left behind by a crash is cleared after this long.
const STALE_MS = 15 * 60_000;

/** The step running now, or null. A step older than the limit was left by a crash and is not reported as running. */
export function activeStep(d: DraftBase): DraftBase["busy"] {
  return d.busy && Date.now() - Date.parse(d.busy.since) < STALE_MS ? d.busy : null;
}

export function draftStore<T extends DraftBase>(prefix: string, label: string) {
  const re = new RegExp(`^${prefix}_[a-z0-9]+$`);
  const validId = (id: string) => { if (!re.test(id)) throw notFound(label, id); return id; };
  const dir = (id: string) => path.join(stagingRoot(), validId(id));
  const file = (id: string) => path.join(dir(id), "draft.json");

  const get = (id: string): T => {
    const f = file(id);
    if (!fs.existsSync(f)) throw notFound(label, id);
    return JSON.parse(fs.readFileSync(f, "utf8")) as T;
  };
  const save = (d: T): T => {
    d.updatedAt = now();
    fs.mkdirSync(dir(d.id), { recursive: true });
    const tmp = `${file(d.id)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
    fs.renameSync(tmp, file(d.id)); // never a half-written draft
    return d;
  };
  /** Newest first. */
  const list = (): T[] => {
    if (!fs.existsSync(stagingRoot())) return [];
    return fs.readdirSync(stagingRoot())
      .filter((n) => re.test(n) && fs.existsSync(file(n)))
      .map((n) => get(n))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };
  /** Removes the draft's staging folder, and only that. */
  const discard = (id: string) => {
    const d = dir(id);
    if (!fs.existsSync(d)) throw notFound(label, id);
    fs.rmSync(d, { recursive: true, force: true });
  };
  /** Runs one step: refuses while another runs, records progress and the outcome. */
  async function step<R>(id: string, name: string, fn: (d: T, report: Report) => Promise<R>): Promise<R> {
    const d = get(id);
    const running = activeStep(d);
    if (running)
      throw new LibraryError("CONFLICT", `This draft is still busy with "${running.step}" (started ${running.since}). Wait for it to finish, then refresh.`);
    d.busy = { step: name, since: now() };
    save(d);
    const report: Report = (detail) => { d.busy = { ...d.busy!, detail }; save(d); };
    try {
      const out = await fn(d, report);
      d.lastError = null;
      return out;
    } catch (err) {
      d.lastError = { step: name, message: (err as Error).message, at: now() };
      throw err;
    } finally {
      d.busy = null;
      save(d);
    }
  }
  return { dir, get, save, list, discard, step, owns: (id: string) => re.test(id) };
}
