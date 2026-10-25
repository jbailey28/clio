import path from "node:path";
import type { DB } from "./db";
import { LibraryError, notFound } from "./errors";
import { checkPath, pathStatus } from "./paths";
import { getComponent, recordActivity, type ComponentSummary } from "./components";
import { newId, now, optionalText, requireText } from "./util";
import { listReleases, versionStatus } from "./releases";
import { isVersion, parseVersion } from "./semver";

export interface Project {
  id: string;
  name: string;
  path: string;
  description: string;
  componentCount: number;
  /** Whether the folder exists right now. Observed on read, never stored. */
  pathStatus: "present" | "missing";
  createdAt: string;
  updatedAt: string;
  /** The latest change to its library record: an edit, or a component added. */
  lastChangedAt: string;
}

export type ProjectSort = "changed" | "name" | "added";
export type Integration = "" | "added" | "connected";

export interface ProjectComponentLink {
  componentId: string;
  slug: string;
  name: string;
  summary: string;
  categoryName: string;
  note: string;
  linkedAt: string;
  /** The version this project is recorded as using. "" = not recorded. Never changed automatically. */
  version: string;
  /** "" = only recorded; "added" = files copied into the project; "connected" = verified in use by the project's tests. */
  integration: Integration;
  integrationDetail: string;
  integrationCheckedAt: string;
  latestVersion: string;
  upgradeAvailable: boolean;
}

export interface ProjectDetail extends Project {
  /** Components this project uses, each at a recorded version. */
  components: ProjectComponentLink[];
  /** Components whose code was captured from this project. That is not use: no version is recorded for these. */
  originOf: { componentId: string; slug: string; name: string }[];
}

const SELECT = `
  SELECT p.id, p.name, p.path, p.description, p.created_at AS createdAt, p.updated_at AS updatedAt,
         (SELECT COUNT(*) FROM project_components pc WHERE pc.project_id = p.id) AS componentCount,
         MAX(p.updated_at, COALESCE((SELECT MAX(pc.created_at) FROM project_components pc WHERE pc.project_id = p.id), '')) AS lastChangedAt
  FROM projects p`;

const ORDER: Record<ProjectSort, string> = {
  changed: "lastChangedAt DESC, p.name COLLATE NOCASE",
  name: "p.name COLLATE NOCASE",
  added: "p.created_at DESC, p.name COLLATE NOCASE",
};

const withStatus = (p: Omit<Project, "pathStatus">): Project => ({ ...p, pathStatus: pathStatus(p.path) });

export function listProjects(db: DB, sort: ProjectSort = "name"): Project[] {
  return (db.prepare(`${SELECT} ORDER BY ${ORDER[sort] ?? ORDER.name}`).all() as Project[]).map(withStatus);
}

/** Accepts an id or the exact registered folder path. */
export function getProject(db: DB, ref: string): ProjectDetail {
  const row = db.prepare(`${SELECT} WHERE p.id = ? OR p.path = ?`).get(ref, ref) as Project | undefined;
  if (!row) throw notFound("Project", ref);
  const components = db
    .prepare(`SELECT c.id AS componentId, c.slug, c.name, c.summary, k.name AS categoryName, pc.note, pc.created_at AS linkedAt, pc.version,
                     pc.integration, pc.integration_detail AS integrationDetail, pc.integration_checked_at AS integrationCheckedAt
              FROM project_components pc JOIN components c ON c.id = pc.component_id JOIN categories k ON k.id = c.category_id
              WHERE pc.project_id = ? ORDER BY c.name COLLATE NOCASE`)
    .all(row.id) as ProjectComponentLink[];
  for (const l of components) Object.assign(l, versionStatus(db, l.componentId, l.version), { version: l.version });
  const originOf = db
    .prepare("SELECT id AS componentId, slug, name FROM components WHERE origin_project_id = ? ORDER BY name COLLATE NOCASE")
    .all(row.id) as ProjectDetail["originOf"];
  return { ...withStatus(row), components, originOf };
}

export interface ProjectInput {
  path: string;
  name?: string;
  description?: string;
}

/**
 * Records an existing folder. Nothing in the folder is read, created or changed.
 */
export function registerProject(db: DB, input: ProjectInput): ProjectDetail {
  const { path: real } = checkPath(db, input.path, "directory");
  const existing = db.prepare("SELECT name FROM projects WHERE path = ?").get(real) as { name: string } | undefined;
  if (existing) throw new LibraryError("CONFLICT", `That folder is already registered as "${existing.name}".`);
  const name = input.name?.trim() ? requireText(input.name, "Project name", 120) : path.basename(real);
  const id = newId("prj");
  const t = now();
  db.prepare("INSERT INTO projects (id, name, path, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id, name, real, optionalText(input.description, "Description", 2000), t, t,
  );
  return getProject(db, id);
}

export function updateProject(db: DB, ref: string, patch: Partial<ProjectInput>): ProjectDetail {
  const cur = getProject(db, ref);
  let newPath = cur.path;
  if (patch.path !== undefined && patch.path.trim() && patch.path.trim() !== cur.path) {
    newPath = checkPath(db, patch.path, "directory").path;
    const clash = db.prepare("SELECT name FROM projects WHERE path = ? AND id != ?").get(newPath, cur.id) as { name: string } | undefined;
    if (clash) throw new LibraryError("CONFLICT", `That folder is already registered as "${clash.name}".`);
  }
  const name = patch.name !== undefined ? requireText(patch.name, "Project name", 120) : cur.name;
  const description = patch.description !== undefined ? optionalText(patch.description, "Description", 2000) : cur.description;
  db.prepare("UPDATE projects SET name = ?, path = ?, description = ?, updated_at = ? WHERE id = ?").run(name, newPath, description, now(), cur.id);
  return getProject(db, cur.id);
}

/** Forgets the project and its component links. The folder on disk is never touched. */
export function unregisterProject(db: DB, ref: string): { deleted: string } {
  const cur = getProject(db, ref);
  db.prepare("DELETE FROM projects WHERE id = ?").run(cur.id);
  return { deleted: cur.id };
}

/** Records that a project uses a component. Writes to the library database only. */
/**
 * Records that a project uses a component. Writes to the library database only.
 * `version` must be a recorded release when the component has releases; it
 * defaults to the newest one. Without releases, it defaults to the component's
 * current version number.
 */
export function linkComponent(db: DB, projectRef: string, componentRef: string, note = "", version?: string): ProjectDetail {
  const project = getProject(db, projectRef);
  const component = getComponent(db, componentRef);
  if (project.components.some((c) => c.componentId === component.id))
    throw new LibraryError("CONFLICT", `"${project.name}" already uses "${component.name}".`);
  const used = resolveLinkVersion(db, component.id, version, component.version);
  db.transaction(() => {
    db.prepare("INSERT INTO project_components (project_id, component_id, note, created_at, version) VALUES (?, ?, ?, ?, ?)").run(
      project.id, component.id, optionalText(note, "Note", 1000), now(), used,
    );
    recordActivity(db, component.id, `added to ${project.name}${used ? ` at ${used}` : ""}`);
  })();
  return getProject(db, project.id);
}

function resolveLinkVersion(db: DB, componentId: string, requested: string | undefined, current: string): string {
  const released = listReleases(db, componentId).map((r) => r.version);
  const want = requested?.trim();
  if (want) {
    parseVersion(want);
    if (released.length && !released.includes(want))
      throw new LibraryError("VALIDATION", `${want} is not a recorded release. Recorded: ${released.join(", ")}.`);
    return want;
  }
  if (released.length) return released[0];
  return isVersion(current) ? current : "";
}

/**
 * Changes the version a project is recorded as using. This is the only way a
 * link's version changes: recording a new release never moves projects.
 * It does not touch the project's files.
 */
export function setLinkVersion(db: DB, projectRef: string, componentRef: string, version: string): ProjectDetail {
  const project = getProject(db, projectRef);
  const component = getComponent(db, componentRef);
  const link = project.components.find((c) => c.componentId === component.id);
  if (!link) throw new LibraryError("NOT_FOUND", `"${project.name}" does not use "${component.name}".`);
  const used = resolveLinkVersion(db, component.id, requireText(version, "Version", 50), component.version);
  if (used === link.version) throw new LibraryError("CONFLICT", `"${project.name}" is already recorded at ${used}.`);
  db.transaction(() => {
    db.prepare("UPDATE project_components SET version = ? WHERE project_id = ? AND component_id = ?").run(used, project.id, component.id);
    recordActivity(db, component.id, `${project.name}: ${link.version || "unrecorded"} → ${used}`);
  })();
  return getProject(db, project.id);
}

export function unlinkComponent(db: DB, projectRef: string, componentRef: string): ProjectDetail {
  const project = getProject(db, projectRef);
  const component = getComponent(db, componentRef);
  const res = db.prepare("DELETE FROM project_components WHERE project_id = ? AND component_id = ?").run(project.id, component.id);
  if (res.changes === 0) throw new LibraryError("NOT_FOUND", `"${project.name}" does not use "${component.name}".`);
  recordActivity(db, component.id, `removed from ${project.name}`);
  return getProject(db, project.id);
}

export type { ComponentSummary };

/**
 * Records how a component is integrated into a project. Only the integration
 * code calls this, after it has done (and checked) the work it describes.
 */
export function setIntegration(db: DB, projectRef: string, componentRef: string, integration: Integration, detail: string) {
  const project = getProject(db, projectRef);
  const component = getComponent(db, componentRef);
  const res = db.prepare("UPDATE project_components SET integration = ?, integration_detail = ?, integration_checked_at = ? WHERE project_id = ? AND component_id = ?")
    .run(integration, optionalText(detail, "Integration detail", 2000), now(), project.id, component.id);
  if (res.changes === 0) throw new LibraryError("NOT_FOUND", `"${project.name}" does not use "${component.name}".`);
  recordActivity(db, component.id, `${project.name}: ${integration || "recorded"}`);
  return getProject(db, project.id);
}
