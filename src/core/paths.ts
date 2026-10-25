import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DB } from "./db";
import { LibraryError } from "./errors";
import { getSettings } from "./settings";

export type PathKind = "file" | "directory";

export interface CheckedPath {
  path: string;
  kind: PathKind;
}

const fail = (message: string, input: string) => new LibraryError("PATH_INVALID", message, { input });

/**
 * The one gate every filesystem path passes through. Returns the real,
 * absolute path (symlinks resolved) or throws a PATH_INVALID error that says
 * exactly what is wrong.
 */
export function checkPath(db: DB, input: string, expect: PathKind | "any" = "any"): CheckedPath {
  const raw = (input ?? "").trim();
  if (!raw) throw fail("A path is required.", input);
  if (raw.includes("\0")) throw fail("Path contains an invalid character.", input);

  const expanded = raw === "~" || raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(1)) : raw;
  if (!path.isAbsolute(expanded)) throw fail(`Path must be absolute (start with / or ~/): "${raw}"`, input);

  const resolved = path.resolve(expanded);
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    throw fail(`Nothing exists at "${resolved}". Check the spelling, or create it first.`, input);
  }
  if (real === "/") throw fail("The whole disk (/) cannot be used.", input);

  const roots = getSettings(db).allowedRoots;
  if (!roots.some((root) => real === root || real.startsWith(root + path.sep)))
    throw fail(`"${real}" is outside the allowed folders (${roots.join(", ")}). Change this in Settings.`, input);

  const stat = fs.statSync(real);
  const kind: PathKind = stat.isDirectory() ? "directory" : "file";
  if (expect !== "any" && kind !== expect)
    throw fail(`"${real}" is a ${kind}, but a ${expect} is required.`, input);
  return { path: real, kind };
}

/** Current on-disk state, for display. "missing" is an observation made now, not a stored verdict. */
export function pathStatus(p: string): "present" | "missing" {
  return fs.existsSync(p) ? "present" : "missing";
}
