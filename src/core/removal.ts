import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DB } from "./db";
import { dataDir, libraryCodeDir } from "./db";
import { LibraryError, invalid } from "./errors";
import { getComponent, deleteComponent } from "./components";
import { getProject, listProjects, unlinkComponent, unregisterProject } from "./projects";
import { lockTree, releasesDir, unlockTree } from "./releases";
import { getSettings, insideReal } from "./settings";

/**
 * Deleting and removing, with the choice to also clear files off the Mac.
 * Files are never deleted outright: they are moved to the Trash, so they can
 * be got back. Only files the choice is about are moved, and only after
 * checks that they can't hold anything else (another project, the library
 * itself, your home folder).
 */

/** The word the person types to confirm a deletion. */
export const CONFIRM_WORD = "delete";
export const confirmed = (typed: string) => typed.trim().toLowerCase() === CONFIRM_WORD;
const mustConfirm = (typed: string) => {
  if (!confirmed(typed)) throw new LibraryError("FORBIDDEN", `To confirm, type "${CONFIRM_WORD}".`);
};

/** The Trash folder (tests point it somewhere else). */
const trashDir = () => process.env.COMPONENT_LIBRARY_TRASH || path.join(os.homedir(), ".Trash");

/** Moves a file or folder into the Trash under a free name. Returns where it went. Never deletes. */
export function moveToTrash(p: string): string {
  const src = path.resolve(p);
  if (!fs.existsSync(src)) throw invalid(`${src} isn't there any more.`);
  fs.mkdirSync(trashDir(), { recursive: true });
  const base = path.basename(src);
  let dest = path.join(trashDir(), base);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(trashDir(), `${base} ${i}`);
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EXDEV") throw invalid(`${src} is on another drive, so it can't be moved to the Trash from here. Nothing was changed.`);
    throw invalid(`${src} couldn't be moved to the Trash (${code ?? (err as Error).message}). Nothing was changed.`);
  }
  return dest;
}

const same = (a: string, b: string) => insideReal(a, b) && insideReal(b, a);
const overlaps = (a: string, b: string) => insideReal(a, b) || insideReal(b, a);

// ---------- projects ----------

/** Whether a project's folder may go to the Trash, and if not, why. */
export function projectFolderCheck(db: DB, ref: string): { folder: string; exists: boolean; canTrash: boolean; why: string } {
  const p = getProject(db, ref);
  const folder = p.path;
  const exists = fs.existsSync(folder);
  const no = (why: string) => ({ folder, exists, canTrash: false, why });
  if (!exists) return no("The folder isn't on your Mac any more.");
  const roots = getSettings(db).allowedRoots;
  if (!roots.some((r) => insideReal(folder, r))) return no("It's outside your allowed folders.");
  if (same(folder, os.homedir()) || roots.some((r) => same(folder, r)) || same(folder, getSettings(db).projectsRoot))
    return no("That's a whole folder of your files, not one project's folder.");
  for (const own of [dataDir(), libraryCodeDir(), process.cwd()]) if (overlaps(folder, own)) return no("It holds the library itself.");
  const other = listProjects(db).find((o) => o.id !== p.id && overlaps(o.path, folder));
  if (other) return no(`Another project, "${other.name}", is ${insideReal(other.path, folder) ? "inside it" : "around it"}.`);
  return { folder, exists, canTrash: true, why: "" };
}

/** Removes a project from the library; with `trashFolder`, also moves its folder to the Trash. */
export function removeProject(db: DB, ref: string, opts: { confirm: string; trashFolder?: boolean }) {
  mustConfirm(opts.confirm);
  const p = getProject(db, ref);
  if (!opts.trashFolder) return { ...unregisterProject(db, p.id), trashed: null as string | null };
  const check = projectFolderCheck(db, p.id);
  if (!check.canTrash) throw invalid(`The folder can't be moved to the Trash: ${check.why} Nothing was changed.`);
  const trashed = moveToTrash(check.folder);
  try {
    return { ...unregisterProject(db, p.id), trashed };
  } catch (err) {
    fs.renameSync(trashed, check.folder); // put it back: nothing changed
    throw err;
  }
}

// ---------- components ----------

/** A component's files: those the library keeps (can go to the Trash) and those it only points to (never touched). */
export function componentFiles(db: DB, ref: string): { library: string[]; elsewhere: string[] } {
  const c = getComponent(db, ref);
  // The library keeps a component's files in its own folder (library/<slug>) and its saved versions in releases/<slug>.
  const own = path.join(libraryCodeDir(), c.slug);
  const library: string[] = [];
  const elsewhere: string[] = [];
  for (const s of c.sources) {
    if (!fs.existsSync(s.path)) continue;
    if (fs.existsSync(own) && insideReal(s.path, own)) { if (!library.includes(own)) library.push(own); }
    else elsewhere.push(s.path);
  }
  const rel = path.join(releasesDir(), c.slug);
  if (fs.existsSync(rel)) library.push(rel);
  return { library, elsewhere };
}

/** Deletes a component from the library; with `trashFiles`, also moves the files the library keeps for it to the Trash. */
export function removeComponent(db: DB, ref: string, opts: { confirm: string; trashFiles?: boolean }) {
  mustConfirm(opts.confirm);
  const c = getComponent(db, ref);
  if (c.projects.length) throw new LibraryError("FORBIDDEN", `"${c.name}" is used by ${c.projects.map((p) => p.projectName).join(", ")}. Remove it from those projects first.`);
  const files = opts.trashFiles ? componentFiles(db, c.id).library : [];
  const moved: { from: string; to: string }[] = [];
  try {
    for (const f of files) {
      if (insideReal(f, releasesDir())) unlockTree(f); // saved versions are read-only on purpose; unlocked only to move them
      moved.push({ from: f, to: moveToTrash(f) });
    }
    deleteComponent(db, c.id, c.slug);
  } catch (err) {
    for (const m of moved.reverse()) fs.renameSync(m.to, m.from); // put back whatever was moved
    for (const f of files) if (insideReal(f, releasesDir()) && fs.existsSync(f)) lockTree(f);
    throw err;
  }
  return { deleted: c.id, name: c.name, category: c.categorySlug, trashed: moved.map((m) => m.to) };
}

// ---------- a component in a project ----------

/** The project's own copy of a component (components/<slug>/), if there is one. */
export function projectCopy(db: DB, projectRef: string, componentRef: string): string | null {
  const p = getProject(db, projectRef);
  const c = getComponent(db, componentRef);
  const copy = path.join(p.path, "components", c.slug);
  return fs.existsSync(copy) && fs.statSync(copy).isDirectory() ? copy : null;
}

/** Removes a component from a project's record; with `trashCopy`, also moves the project's copy of it to the Trash. */
export function removeFromProject(db: DB, projectRef: string, componentRef: string, opts: { trashCopy?: boolean; confirm?: string } = {}) {
  if (!opts.trashCopy) return { project: unlinkComponent(db, projectRef, componentRef), trashed: null as string | null };
  mustConfirm(opts.confirm ?? "");
  const copy = projectCopy(db, projectRef, componentRef);
  if (!copy) throw invalid("The project has no copy of it to move. Nothing was changed.");
  const trashed = moveToTrash(copy);
  try {
    return { project: unlinkComponent(db, projectRef, componentRef), trashed };
  } catch (err) {
    fs.renameSync(trashed, copy);
    throw err;
  }
}
