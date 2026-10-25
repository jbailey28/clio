/**
 * Ordered, append-only migrations. Never edit a migration that has shipped;
 * add a new one. Each runs once, inside a transaction, and is recorded in
 * schema_migrations, so running migrate() again is a no-op.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "initial schema",
    sql: `
CREATE TABLE categories (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE components (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  category_id   TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  summary       TEXT NOT NULL DEFAULT '',
  documentation TEXT NOT NULL DEFAULT '',
  language      TEXT NOT NULL DEFAULT '',
  version       TEXT NOT NULL DEFAULT '',
  test_command  TEXT NOT NULL DEFAULT '',
  test_cwd      TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_components_category ON components(category_id);

CREATE TABLE component_sources (
  id           TEXT PRIMARY KEY,
  component_id TEXT NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('file','directory')),
  is_primary   INTEGER NOT NULL DEFAULT 0,
  position     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (component_id, path)
);

CREATE TABLE capabilities (
  id           TEXT PRIMARY KEY,
  component_id TEXT NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL DEFAULT 'capability' CHECK (kind IN ('capability','check')),
  position     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (component_id, name)
);

CREATE TABLE component_io (
  id           TEXT PRIMARY KEY,
  component_id TEXT NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  direction    TEXT NOT NULL CHECK (direction IN ('input','output')),
  name         TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  position     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (component_id, direction, name)
);

CREATE TABLE component_dependencies (
  id                      TEXT PRIMARY KEY,
  component_id            TEXT NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  dep_type                TEXT NOT NULL CHECK (dep_type IN ('package','component','system')),
  name                    TEXT NOT NULL,
  version                 TEXT NOT NULL DEFAULT '',
  depends_on_component_id TEXT REFERENCES components(id) ON DELETE SET NULL,
  position                INTEGER NOT NULL DEFAULT 0,
  UNIQUE (component_id, dep_type, name)
);

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE project_components (
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  component_id TEXT NOT NULL REFERENCES components(id) ON DELETE RESTRICT,
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, component_id)
);
CREATE INDEX idx_project_components_component ON project_components(component_id);

CREATE TABLE test_runs (
  id           TEXT PRIMARY KEY,
  component_id TEXT NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  command      TEXT NOT NULL,
  cwd          TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('passed','failed','error','timeout')),
  exit_code    INTEGER,
  stdout       TEXT NOT NULL DEFAULT '',
  stderr       TEXT NOT NULL DEFAULT '',
  duration_ms  INTEGER NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT NOT NULL
);
CREATE INDEX idx_test_runs_component ON test_runs(component_id, started_at);

CREATE TABLE activity (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  component_id TEXT NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  action       TEXT NOT NULL,
  at           TEXT NOT NULL
);
CREATE INDEX idx_activity_component ON activity(component_id, at);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: "releases and project component versions",
    sql: `
CREATE TABLE component_releases (
  id           TEXT PRIMARY KEY,
  component_id TEXT NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  version      TEXT NOT NULL,
  source_path  TEXT NOT NULL,
  checksum     TEXT NOT NULL,
  file_count   INTEGER NOT NULL,
  changes      TEXT NOT NULL DEFAULT '',
  git_tag      TEXT NOT NULL DEFAULT '',
  released_at  TEXT NOT NULL,
  UNIQUE (component_id, version)
);
-- '' = no version recorded for this link (links made before versions existed).
ALTER TABLE project_components ADD COLUMN version TEXT NOT NULL DEFAULT '';
`,
  },
  {
    version: 3,
    name: "where a captured component came from",
    sql: `
-- The project a component was extracted from. Separate from project_components,
-- which records projects that USE a released version: being the origin is not using.
ALTER TABLE components ADD COLUMN origin_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
-- JSON array of the original paths in that project ('[]' = not captured, or origin unknown).
ALTER TABLE components ADD COLUMN origin_paths TEXT NOT NULL DEFAULT '[]';
`,
  },
  {
    version: 4,
    name: "how a project's component is integrated",
    sql: `
-- '' = only recorded (links made before this, or by hand); 'added' = the release's files were copied
-- into the project; 'connected' = the project's tests ran in the sandbox and called the component.
ALTER TABLE project_components ADD COLUMN integration TEXT NOT NULL DEFAULT '';
-- Plain words on how that was established, and when.
ALTER TABLE project_components ADD COLUMN integration_detail TEXT NOT NULL DEFAULT '';
ALTER TABLE project_components ADD COLUMN integration_checked_at TEXT NOT NULL DEFAULT '';
`,
  },
];
