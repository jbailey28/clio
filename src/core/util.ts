import crypto from "node:crypto";
import { invalid } from "./errors";

/** Stable, prefixed IDs: cat_…, cmp_…, prj_… Never reused, never derived from names. */
export const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(10).toString("hex")}`;

export const now = () => new Date().toISOString();

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function requireText(value: unknown, field: string, max = 200): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) throw invalid(`${field} is required.`);
  if (s.length > max) throw invalid(`${field} must be ${max} characters or fewer.`);
  return s;
}

export function optionalText(value: unknown, field: string, max = 20000): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw invalid(`${field} must be text.`);
  const s = value.trim();
  if (s.length > max) throw invalid(`${field} must be ${max} characters or fewer.`);
  return s;
}

export function validSlug(value: string, field = "Slug"): string {
  const s = value.trim();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s))
    throw invalid(`${field} "${value}" must be lowercase letters, numbers and single dashes.`);
  return s;
}

/** Escapes a user term for use inside a LIKE pattern with ESCAPE '\'. */
export const likeTerm = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
