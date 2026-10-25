import type { DB } from "./db";
import { LibraryError, invalid, notFound } from "./errors";
import { checkPath, pathStatus, type PathKind } from "./paths";
import { getCategory } from "./categories";
import { likeTerm, newId, now, optionalText, requireText, slugify, validSlug } from "./util";
import { compareVersions, isVersion } from "./semver";

export type TestStatus = "passed" | "failed" | "error" | "timeout";

export interface ComponentSummary {
  id: string;
  slug: string;
  name: string;
  summary: string;
  language: string;
  version: string;
  categoryId: string;
  categoryName: string;
  categorySlug: string;
  capabilityCount: number;
  projectCount: number;
  /** null means no test has ever been run. That is not a failure. */
  lastTestStatus: TestStatus | null;
  lastTestAt: string | null;
  updatedAt: string;
}

export interface Capability { id: string; name: string; description: string; kind: "capability" | "check" }
export interface IOItem { id: string; name: string; type: string; description: string }
export interface Dependency {
  id: string;
  type: "package" | "component" | "system";
  name: string;
  version: string;
  dependsOnComponentId: string | null;
}
export interface SourcePath { id: string; path: string; kind: PathKind; isPrimary: boolean; status: "present" | "missing" }
export interface ComponentProjectLink {
  projectId: string;
  projectName: string;
  projectPath: string;
  note: string;
  linkedAt: string;
  /** The version this project is recorded as using. "" = not recorded. */
  version: string;
  latestVersion: string;
  upgradeAvailable: boolean;
}

export interface ComponentDetail extends ComponentSummary {
  documentation: string;
  testCommand: string;
  testCwd: string;
  createdAt: string;
  sources: SourcePath[];
  capabilities: Capability[];
  inputs: IOItem[];
  outputs: IOItem[];
  dependencies: Dependency[];
  projects: ComponentProjectLink[];
  /** Versions with a recorded release, newest first. Empty until the first release is recorded. */
  releasedVersions: string[];
  /** Where the code was extracted from, if it was captured from a project. Not a record of use. */
  origin: ComponentOrigin | null;
}

export interface ComponentOrigin {
  /** null when the source folder was not a registered project, or that project was later unregistered. */
  project: { id: string; name: string; path: string } | null;
  /** The original files or folders in that project. They are only ever read. */
  paths: string[];
}

export interface ComponentInput {
  name: string;
  category: string;
  slug?: string;
  summary?: string;
  documentation?: string;
  language?: string;
  version?: string;
  testCommand?: string;
  testCwd?: string;
  /** Absolute paths to real files or folders. The first one is the primary source. */
  sources: string[];
  capabilities?: { name: string; description?: string; kind?: "capability" | "check" }[];
  inputs?: { name: string; type?: string; description?: string }[];
  outputs?: { name: string; type?: string; description?: string }[];
  dependencies?: { type: "package" | "component" | "system"; name: string; version?: string }[];
}

const SUMMARY_SELECT = `
  SELECT c.id, c.slug, c.name, c.summary, c.language, c.version, c.updated_at AS updatedAt,
         c.category_id AS categoryId, k.name AS categoryName, k.slug AS categorySlug,
         (SELECT COUNT(*) FROM capabilities x WHERE x.component_id = c.id) AS capabilityCount,
         (SELECT COUNT(*) FROM project_components p WHERE p.component_id = c.id) AS projectCount,
         (SELECT status FROM test_runs t WHERE t.component_id = c.id ORDER BY t.started_at DESC LIMIT 1) AS lastTestStatus,
         (SELECT started_at FROM test_runs t WHERE t.component_id = c.id ORDER BY t.started_at DESC LIMIT 1) AS lastTestAt
  FROM components c JOIN categories k ON k.id = c.category_id`;

/**
 * Every whitespace-separated term must match somewhere: name, slug, summary,
 * documentation, language, category, or any capability/check name or description.
 */
export function searchComponents(db: DB, query = "", opts: { category?: string; limit?: number } = {}): ComponentSummary[] {
  const terms = query.trim().split(/\s+/).filter(Boolean).slice(0, 10);
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const t of terms) {
    clauses.push(`(c.name LIKE ? ESCAPE '\\' OR c.slug LIKE ? ESCAPE '\\' OR c.summary LIKE ? ESCAPE '\\'
      OR c.documentation LIKE ? ESCAPE '\\' OR c.language LIKE ? ESCAPE '\\' OR k.name LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM capabilities x WHERE x.component_id = c.id
                 AND (x.name LIKE ? ESCAPE '\\' OR x.description LIKE ? ESCAPE '\\')))`);
    params.push(...Array(8).fill(likeTerm(t)));
  }
  if (opts.category) {
    clauses.push("c.category_id = ?");
    params.push(getCategory(db, opts.category).id);
  }
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  // Name matches first, then most recently changed.
  const order = terms.length
    ? `ORDER BY (c.name LIKE ? ESCAPE '\\') DESC, c.updated_at DESC`
    : `ORDER BY c.name COLLATE NOCASE`;
  if (terms.length) params.push(likeTerm(terms[0]));
  return db.prepare(`${SUMMARY_SELECT} ${where} ${order} LIMIT ${limit}`).all(...params) as ComponentSummary[];
}

function resolveId(db: DB, ref: string): string {
  const row = db.prepare("SELECT id FROM components WHERE id = ? OR slug = ?").get(ref, ref) as { id: string } | undefined;
  if (!row) throw notFound("Component", ref);
  return row.id;
}

/** Accepts an id or a slug. */
export function getComponent(db: DB, ref: string): ComponentDetail {
  const id = resolveId(db, ref);
  const base = db.prepare(`${SUMMARY_SELECT} WHERE c.id = ?`).get(id) as ComponentSummary;
  const extra = db
    .prepare(`SELECT documentation, test_command AS testCommand, test_cwd AS testCwd, created_at AS createdAt,
                     origin_project_id AS originProjectId, origin_paths AS originPaths FROM components WHERE id = ?`)
    .get(id) as Pick<ComponentDetail, "documentation" | "testCommand" | "testCwd" | "createdAt"> & { originProjectId: string | null; originPaths: string };
  const { originProjectId, originPaths, ...detail } = extra;
  const originProject = originProjectId
    ? (db.prepare("SELECT id, name, path FROM projects WHERE id = ?").get(originProjectId) as ComponentOrigin["project"]) ?? null
    : null;
  const paths = JSON.parse(originPaths || "[]") as string[];
  const origin: ComponentOrigin | null = originProject || paths.length ? { project: originProject, paths } : null;

  const sources = (
    db.prepare("SELECT id, path, kind, is_primary AS isPrimary FROM component_sources WHERE component_id = ? ORDER BY position").all(id) as any[]
  ).map((s) => ({ ...s, isPrimary: !!s.isPrimary, status: pathStatus(s.path) }));
  const capabilities = db
    .prepare("SELECT id, name, description, kind FROM capabilities WHERE component_id = ? ORDER BY position").all(id) as Capability[];
  const io = db
    .prepare("SELECT id, direction, name, type, description FROM component_io WHERE component_id = ? ORDER BY position").all(id) as (IOItem & { direction: string })[];
  const dependencies = db
    .prepare(`SELECT id, dep_type AS type, name, version, depends_on_component_id AS dependsOnComponentId
              FROM component_dependencies WHERE component_id = ? ORDER BY position`).all(id) as Dependency[];
  const projects = db
    .prepare(`SELECT p.id AS projectId, p.name AS projectName, p.path AS projectPath, pc.note, pc.created_at AS linkedAt, pc.version
              FROM project_components pc JOIN projects p ON p.id = pc.project_id
              WHERE pc.component_id = ? ORDER BY p.name COLLATE NOCASE`).all(id) as ComponentProjectLink[];
  const releasedVersions = (db.prepare("SELECT version FROM component_releases WHERE component_id = ?").all(id) as { version: string }[])
    .map((r) => r.version).filter(isVersion).sort(compareVersions).reverse();
  const latestVersion = releasedVersions[0] ?? "";
  for (const p of projects) {
    p.latestVersion = latestVersion;
    p.upgradeAvailable = !!(p.version && latestVersion && isVersion(p.version) && compareVersions(latestVersion, p.version) > 0);
  }

  const strip = ({ direction: _d, ...rest }: IOItem & { direction: string }) => rest;
  return {
    ...base,
    ...detail,
    sources,
    capabilities,
    inputs: io.filter((i) => i.direction === "input").map(strip),
    outputs: io.filter((i) => i.direction === "output").map(strip),
    dependencies,
    projects,
    releasedVersions,
    origin,
  };
}

/**
 * Records where a captured component came from. `paths` must sit inside the
 * project's folder when a project is given. Library record only.
 */
export function setOrigin(db: DB, componentRef: string, origin: { projectId: string | null; paths: string[] }) {
  const c = getComponent(db, componentRef);
  db.prepare("UPDATE components SET origin_project_id = ?, origin_paths = ? WHERE id = ?").run(origin.projectId, JSON.stringify(origin.paths), c.id);
  return getComponent(db, c.id);
}

// ---------- writes ----------

interface Normalized {
  name: string;
  slug: string;
  categoryId: string;
  summary: string;
  documentation: string;
  language: string;
  version: string;
  testCommand: string;
  testCwd: string;
}

function normalize(db: DB, input: Partial<ComponentInput>, cur?: ComponentDetail): Normalized {
  const name = input.name !== undefined ? requireText(input.name, "Component name", 120) : cur!.name;
  const slug =
    input.slug !== undefined && input.slug.trim() ? validSlug(input.slug) : cur ? cur.slug : validSlug(slugify(name), "Slug (made from the name)");
  const categoryId =
    input.category !== undefined
      ? getCategory(db, requireText(input.category, "Category")).id
      : cur ? cur.categoryId : (() => { throw invalid("Category is required."); })();
  const testCwd =
    input.testCwd !== undefined
      ? input.testCwd.trim() ? checkPath(db, input.testCwd, "directory").path : ""
      : cur?.testCwd ?? "";
  return {
    name,
    slug,
    categoryId,
    summary: input.summary !== undefined ? optionalText(input.summary, "Description", 2000) : cur?.summary ?? "",
    documentation: input.documentation !== undefined ? optionalText(input.documentation, "Documentation", 100000) : cur?.documentation ?? "",
    language: input.language !== undefined ? optionalText(input.language, "Language", 50) : cur?.language ?? "",
    version: input.version !== undefined ? optionalText(input.version, "Version", 50) : cur?.version ?? "",
    testCommand: input.testCommand !== undefined ? optionalText(input.testCommand, "Test command", 2000) : cur?.testCommand ?? "",
    testCwd,
  };
}

function assertSlugFree(db: DB, slug: string, exceptId?: string) {
  const clash = db.prepare("SELECT name FROM components WHERE slug = ? AND id IS NOT ?").get(slug, exceptId ?? null) as
    | { name: string }
    | undefined;
  if (clash) throw new LibraryError("CONFLICT", `The slug "${slug}" is already used by "${clash.name}". Pick another slug.`);
}

/**
 * Replaces a child list. Items whose key matches an existing row keep that
 * row's id, so ids stay stable across edits.
 */
function syncChildren<T>(
  db: DB,
  table: string,
  componentId: string,
  scope: { where: string; params: unknown[] },
  items: T[],
  key: (item: T) => string,
  existingKey: string,
  prefix: string,
  write: (id: string, item: T, position: number, isNew: boolean) => void,
) {
  const existing = new Map(
    (db.prepare(`SELECT id, ${existingKey} AS k FROM ${table} WHERE component_id = ? ${scope.where}`).all(componentId, ...scope.params) as {
      id: string;
      k: string;
    }[]).map((r) => [r.k, r.id]),
  );
  const keep = new Set<string>();
  const seen = new Set<string>();
  items.forEach((item, i) => {
    const k = key(item);
    if (seen.has(k)) throw invalid(`"${k}" is listed twice.`);
    seen.add(k);
    const id = existing.get(k);
    if (id) keep.add(id);
    write(id ?? newId(prefix), item, i, !id);
  });
  for (const id of existing.values())
    if (!keep.has(id)) db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
}

function writeChildren(db: DB, componentId: string, input: Partial<ComponentInput>) {
  if (input.sources !== undefined) {
    if (input.sources.filter((s) => s.trim()).length === 0)
      throw invalid("At least one source path is required. A component must point at real code.");
    const checked = input.sources.filter((s) => s.trim()).map((s) => checkPath(db, s));
    syncChildren(db, "component_sources", componentId, { where: "", params: [] }, checked, (c) => c.path, "path", "src",
      (id, c, pos, isNew) => {
        if (isNew) db.prepare("INSERT INTO component_sources (id, component_id, path, kind, is_primary, position) VALUES (?, ?, ?, ?, ?, ?)")
          .run(id, componentId, c.path, c.kind, pos === 0 ? 1 : 0, pos);
        else db.prepare("UPDATE component_sources SET kind = ?, is_primary = ?, position = ? WHERE id = ?").run(c.kind, pos === 0 ? 1 : 0, pos, id);
      });
  }

  if (input.capabilities !== undefined) {
    const caps = input.capabilities.map((c) => ({
      name: requireText(c.name, "Capability name", 200),
      description: optionalText(c.description, "Capability description", 2000),
      kind: c.kind === "check" ? "check" : "capability",
    }));
    syncChildren(db, "capabilities", componentId, { where: "", params: [] }, caps, (c) => c.name, "name", "cap",
      (id, c, pos, isNew) => {
        if (isNew) db.prepare("INSERT INTO capabilities (id, component_id, name, description, kind, position) VALUES (?, ?, ?, ?, ?, ?)")
          .run(id, componentId, c.name, c.description, c.kind, pos);
        else db.prepare("UPDATE capabilities SET description = ?, kind = ?, position = ? WHERE id = ?").run(c.description, c.kind, pos, id);
      });
  }

  for (const direction of ["input", "output"] as const) {
    const list = direction === "input" ? input.inputs : input.outputs;
    if (list === undefined) continue;
    const items = list.map((i) => ({
      name: requireText(i.name, `${direction} name`, 200),
      type: optionalText(i.type, `${direction} type`, 200),
      description: optionalText(i.description, `${direction} description`, 2000),
    }));
    syncChildren(db, "component_io", componentId, { where: "AND direction = ?", params: [direction] }, items, (i) => i.name, "name", "io",
      (id, i, pos, isNew) => {
        if (isNew) db.prepare("INSERT INTO component_io (id, component_id, direction, name, type, description, position) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(id, componentId, direction, i.name, i.type, i.description, pos);
        else db.prepare("UPDATE component_io SET type = ?, description = ?, position = ? WHERE id = ?").run(i.type, i.description, pos, id);
      });
  }

  if (input.dependencies !== undefined) {
    const deps = input.dependencies.map((d) => {
      if (!["package", "component", "system"].includes(d.type)) throw invalid(`Unknown dependency type "${d.type}".`);
      const name = requireText(d.name, "Dependency name", 200);
      let target: string | null = null;
      if (d.type === "component") {
        const row = db.prepare("SELECT id FROM components WHERE slug = ? OR id = ?").get(name, name) as { id: string } | undefined;
        if (!row) throw invalid(`Dependency "component:${name}" does not match any component in the library.`);
        if (row.id === componentId) throw invalid("A component cannot depend on itself.");
        target = row.id;
      }
      return { type: d.type, name, version: optionalText(d.version, "Dependency version", 100), target };
    });
    syncChildren(db, "component_dependencies", componentId, { where: "", params: [] }, deps, (d) => `${d.type}:${d.name}`,
      "dep_type || ':' || name", "dep",
      (id, d, pos, isNew) => {
        if (isNew) db.prepare(`INSERT INTO component_dependencies (id, component_id, dep_type, name, version, depends_on_component_id, position)
                              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, componentId, d.type, d.name, d.version, d.target, pos);
        else db.prepare("UPDATE component_dependencies SET version = ?, depends_on_component_id = ?, position = ? WHERE id = ?")
          .run(d.version, d.target, pos, id);
      });
  }
}

export function recordActivity(db: DB, componentId: string, action: string) {
  db.prepare("INSERT INTO activity (component_id, action, at) VALUES (?, ?, ?)").run(componentId, action, now());
}

export function createComponent(db: DB, input: ComponentInput): ComponentDetail {
  if (!input || !Array.isArray(input.sources)) throw invalid("At least one source path is required. A component must point at real code.");
  const n = normalize(db, input);
  assertSlugFree(db, n.slug);
  const id = newId("cmp");
  db.transaction(() => {
    const t = now();
    db.prepare(`INSERT INTO components (id, slug, name, category_id, summary, documentation, language, version, test_command, test_cwd, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, n.slug, n.name, n.categoryId, n.summary, n.documentation, n.language, n.version, n.testCommand, n.testCwd, t, t);
    writeChildren(db, id, input);
    recordActivity(db, id, "created");
  })();
  return getComponent(db, id);
}

/** Only the fields present in `patch` change. A list that is present replaces the old list. */
export function updateComponent(db: DB, ref: string, patch: Partial<ComponentInput>): ComponentDetail {
  const cur = getComponent(db, ref);
  const n = normalize(db, patch, cur);
  assertSlugFree(db, n.slug, cur.id);
  db.transaction(() => {
    db.prepare(`UPDATE components SET slug = ?, name = ?, category_id = ?, summary = ?, documentation = ?, language = ?, version = ?,
                test_command = ?, test_cwd = ?, updated_at = ? WHERE id = ?`)
      .run(n.slug, n.name, n.categoryId, n.summary, n.documentation, n.language, n.version, n.testCommand, n.testCwd, now(), cur.id);
    writeChildren(db, cur.id, patch);
    recordActivity(db, cur.id, "edited");
  })();
  return getComponent(db, cur.id);
}

/**
 * Removes the library record only. Source files on disk are never touched.
 * Refuses while any project uses the component, and requires `confirm` to equal the slug.
 */
export function deleteComponent(db: DB, ref: string, confirm: string): { deleted: string } {
  const cur = getComponent(db, ref);
  if (confirm?.trim() !== cur.slug)
    throw new LibraryError("FORBIDDEN", `To delete, type the slug "${cur.slug}" exactly.`);
  if (cur.projects.length)
    throw new LibraryError(
      "FORBIDDEN",
      `"${cur.name}" is used by ${cur.projects.map((p) => p.projectName).join(", ")}. Remove it from those projects first.`,
    );
  db.transaction(() => {
    db.prepare("UPDATE component_dependencies SET depends_on_component_id = NULL WHERE depends_on_component_id = ?").run(cur.id);
    db.prepare("DELETE FROM components WHERE id = ?").run(cur.id);
  })();
  return { deleted: cur.id };
}

export interface RecentItem extends ComponentSummary {
  lastAction: string;
  lastActionAt: string;
}

export function recentComponents(db: DB, limit = 50): RecentItem[] {
  const rows = db
    .prepare(`SELECT a.component_id AS id, a.action AS lastAction, a.at AS lastActionAt FROM activity a
              WHERE a.id = (SELECT MAX(b.id) FROM activity b WHERE b.component_id = a.component_id)
              ORDER BY a.id DESC LIMIT ?`)
    .all(Math.min(limit, 500)) as { id: string; lastAction: string; lastActionAt: string }[];
  const one = db.prepare(`${SUMMARY_SELECT} WHERE c.id = ?`);
  return rows.map((r) => ({ ...(one.get(r.id) as ComponentSummary), lastAction: r.lastAction, lastActionAt: r.lastActionAt }));
}

/** Adds one capability or check without touching the others. Refuses a name that already exists. */
export function addCapability(
  db: DB,
  ref: string,
  cap: { name: string; description?: string; kind?: "capability" | "check" },
): ComponentDetail {
  const c = getComponent(db, ref);
  const name = requireText(cap.name, "Capability name", 200);
  if (c.capabilities.some((x) => x.name.toLowerCase() === name.toLowerCase()))
    throw new LibraryError("CONFLICT", `"${c.name}" already has a capability or check called "${name}".`);
  db.transaction(() => {
    db.prepare("INSERT INTO capabilities (id, component_id, name, description, kind, position) VALUES (?, ?, ?, ?, ?, ?)").run(
      newId("cap"), c.id, name, optionalText(cap.description, "Capability description", 2000),
      cap.kind === "check" ? "check" : "capability", c.capabilities.length,
    );
    db.prepare("UPDATE components SET updated_at = ? WHERE id = ?").run(now(), c.id);
    recordActivity(db, c.id, `${cap.kind === "check" ? "check" : "capability"} added`);
  })();
  return getComponent(db, c.id);
}
