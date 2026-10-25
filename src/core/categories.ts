import type { DB } from "./db";
import { LibraryError, notFound } from "./errors";
import { likeTerm, newId, now, optionalText, requireText, slugify, validSlug } from "./util";

export interface Category {
  id: string;
  slug: string;
  name: string;
  description: string;
  componentCount: number;
  createdAt: string;
  updatedAt: string;
  /** Latest activity (viewed, edited, tested, linked, released) of any component in it. null = never used. */
  lastUsedAt: string | null;
}

export type CategorySort = "name" | "added" | "used";

const SELECT = `
  SELECT c.id, c.slug, c.name, c.description, c.created_at AS createdAt, c.updated_at AS updatedAt,
         (SELECT COUNT(*) FROM components x WHERE x.category_id = c.id) AS componentCount,
         (SELECT MAX(a.at) FROM activity a JOIN components x ON x.id = a.component_id WHERE x.category_id = c.id) AS lastUsedAt
  FROM categories c`;

const ORDER: Record<CategorySort, string> = {
  name: "c.name COLLATE NOCASE",
  added: "c.created_at DESC, c.name COLLATE NOCASE",
  // Never-used categories go last, then by name.
  used: "lastUsedAt IS NULL, lastUsedAt DESC, c.name COLLATE NOCASE",
};

export function listCategories(db: DB, query = "", sort: CategorySort = "name"): Category[] {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  const where = terms.map(() => `(c.name LIKE ? ESCAPE '\\' OR c.description LIKE ? ESCAPE '\\')`).join(" AND ");
  const params = terms.flatMap((t) => [likeTerm(t), likeTerm(t)]);
  return db.prepare(`${SELECT} ${where ? `WHERE ${where}` : ""} ORDER BY ${ORDER[sort] ?? ORDER.name}`).all(...params) as Category[];
}

/** Accepts an id or a slug. */
export function getCategory(db: DB, ref: string): Category {
  const row = db.prepare(`${SELECT} WHERE c.id = ? OR c.slug = ?`).get(ref, ref) as Category | undefined;
  if (!row) throw notFound("Category", ref);
  return row;
}

export interface CategoryInput {
  name: string;
  description?: string;
  slug?: string;
}

function assertUnique(db: DB, name: string, slug: string, exceptId?: string) {
  const clash = db
    .prepare("SELECT id, name, slug FROM categories WHERE (name = ? COLLATE NOCASE OR slug = ?) AND id IS NOT ?")
    .get(name, slug, exceptId ?? null) as { name: string } | undefined;
  if (clash) throw new LibraryError("CONFLICT", `A category called "${clash.name}" already exists.`);
}

export function createCategory(db: DB, input: CategoryInput): Category {
  const name = requireText(input.name, "Category name", 100);
  const slug = validSlug(input.slug?.trim() || slugify(name));
  const description = optionalText(input.description, "Description", 2000);
  assertUnique(db, name, slug);
  const id = newId("cat");
  const t = now();
  db.prepare("INSERT INTO categories (id, slug, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id, slug, name, description, t, t,
  );
  return getCategory(db, id);
}

export function updateCategory(db: DB, ref: string, input: Partial<CategoryInput>): Category {
  const cur = getCategory(db, ref);
  const name = input.name !== undefined ? requireText(input.name, "Category name", 100) : cur.name;
  const slug = input.slug !== undefined && input.slug.trim() ? validSlug(input.slug) : cur.slug;
  const description = input.description !== undefined ? optionalText(input.description, "Description", 2000) : cur.description;
  assertUnique(db, name, slug, cur.id);
  db.prepare("UPDATE categories SET name = ?, slug = ?, description = ?, updated_at = ? WHERE id = ?").run(
    name, slug, description, now(), cur.id,
  );
  return getCategory(db, cur.id);
}

/** Refuses while the category still holds components, so nothing is orphaned. */
export function deleteCategory(db: DB, ref: string): { deleted: string } {
  const cur = getCategory(db, ref);
  if (cur.componentCount > 0)
    throw new LibraryError(
      "FORBIDDEN",
      `"${cur.name}" still has ${cur.componentCount} component(s). Move or delete them first.`,
    );
  db.prepare("DELETE FROM categories WHERE id = ?").run(cur.id);
  return { deleted: cur.id };
}
