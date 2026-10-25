import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLibrary, openLibrary, type Library } from "../src/core";
import { migrate, openDatabase } from "../src/core/db";
import { migrations } from "../src/core/migrations";

let tmp: string;
let lib: Library;
let srcDir: string;
let projDir: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cl-test-")));
  srcDir = path.join(tmp, "code", "retry");
  projDir = path.join(tmp, "projects", "app-one");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, "retry.ts"), "export const retry = () => 1;\n");
  lib = openLibrary(path.join(tmp, "db", "library.db"));
  lib.settings.update({ allowedRoots: [tmp] });
});

afterEach(() => {
  lib.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const makeComponent = (overrides: Record<string, unknown> = {}) => {
  lib.categories.create({ name: "Networking" });
  return lib.components.create({
    name: "Retry with backoff",
    category: "networking",
    summary: "Retries failed fetches",
    sources: [srcDir],
    capabilities: [{ name: "Exponential backoff", description: "doubles the wait" }, { name: "Gives up after N", kind: "check" }],
    inputs: [{ name: "attempts", type: "number" }],
    outputs: [{ name: "result", type: "Promise<T>" }],
    dependencies: [{ type: "package", name: "zod", version: "^3" }],
    ...overrides,
  } as any);
};

describe("migrations", () => {
  it("are repeatable", () => {
    const db = openDatabase(path.join(tmp, "m.db"));
    expect(migrate(db)).toEqual([]);
    expect(migrate(db)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) n FROM schema_migrations").get()).toEqual({ n: migrations.length });
    db.close();
  });
});

describe("categories", () => {
  it("creates, searches, rejects duplicates, and refuses to delete when not empty", () => {
    const cat = lib.categories.create({ name: "Auth", description: "login things" });
    expect(cat.id).toMatch(/^cat_/);
    expect(cat.slug).toBe("auth");
    expect(lib.categories.list("login").map((c) => c.name)).toEqual(["Auth"]);
    expect(() => lib.categories.create({ name: "auth" })).toThrow(/already exists/);
    expect(() => lib.categories.create({ name: "  " })).toThrow(/required/);
    makeComponent();
    expect(() => lib.categories.delete("networking")).toThrow(/still has 1/);
    expect(lib.categories.delete("auth")).toEqual({ deleted: cat.id });
  });
});

describe("components", () => {
  it("registers a component with real source and all its parts", () => {
    const c = makeComponent();
    expect(c.id).toMatch(/^cmp_/);
    expect(c.slug).toBe("retry-with-backoff");
    expect(c.sources).toEqual([expect.objectContaining({ path: srcDir, kind: "directory", isPrimary: true, status: "present" })]);
    expect(c.capabilities.map((x) => [x.name, x.kind])).toEqual([
      ["Exponential backoff", "capability"],
      ["Gives up after N", "check"],
    ]);
    expect(c.inputs[0].name).toBe("attempts");
    expect(c.outputs[0].type).toBe("Promise<T>");
    expect(c.dependencies[0]).toMatchObject({ type: "package", name: "zod", version: "^3" });
    expect(c.lastTestStatus).toBeNull();
  });

  it("requires a real source path inside the allowed folders", () => {
    lib.categories.create({ name: "Networking" });
    const base = { name: "X", category: "networking" };
    expect(() => lib.components.create({ ...base, sources: [] })).toThrow(/At least one source path/);
    expect(() => lib.components.create({ ...base, sources: [path.join(tmp, "nope")] })).toThrow(/Nothing exists/);
    expect(() => lib.components.create({ ...base, sources: ["relative/path"] })).toThrow(/must be absolute/);
    expect(() => lib.components.create({ ...base, sources: ["/etc"] })).toThrow(/outside the allowed folders/);
    expect(() => lib.components.create({ ...base, category: "nope", sources: [srcDir] })).toThrow(/Category not found/);
    expect(lib.components.search()).toHaveLength(0); // nothing half-written
  });

  it("searches by name, description, and capability", () => {
    makeComponent();
    expect(lib.components.search("retry")).toHaveLength(1);
    expect(lib.components.search("failed fetches")).toHaveLength(1);
    expect(lib.components.search("backoff exponential")).toHaveLength(1);
    expect(lib.components.search("gives up")).toHaveLength(1);
    expect(lib.components.search("100%")).toHaveLength(0); // LIKE wildcards are escaped
    expect(lib.components.search("graphql")).toHaveLength(0);
  });

  it("edits keep ids stable and persist across reopening the database", () => {
    const c = makeComponent();
    const capId = c.capabilities[0].id;
    const updated = lib.components.update(c.slug, {
      summary: "Retries with jitter",
      capabilities: [{ name: "Exponential backoff", description: "now with jitter" }, { name: "Jitter" }],
    });
    expect(updated.capabilities[0].id).toBe(capId);
    expect(updated.capabilities.map((x) => x.name)).toEqual(["Exponential backoff", "Jitter"]);
    expect(updated.inputs).toHaveLength(1); // untouched lists stay

    const dbPath = lib.dbPath;
    lib.db.close();
    lib = openLibrary(dbPath);
    const again = lib.components.get(c.id);
    expect(again.summary).toBe("Retries with jitter");
    expect(again.capabilities[0].description).toBe("now with jitter");
  });

  it("delete needs the slug and refuses while a project uses it, and never touches files", () => {
    const c = makeComponent();
    const p = lib.projects.register({ path: projDir });
    lib.projects.link(p.id, c.id);
    expect(() => lib.components.delete(c.id, "wrong")).toThrow(/type the slug/);
    expect(() => lib.components.delete(c.id, c.slug)).toThrow(/used by app-one/);
    lib.projects.unlink(p.id, c.id);
    lib.components.delete(c.id, c.slug);
    expect(() => lib.components.get(c.id)).toThrow(/not found/);
    expect(fs.existsSync(path.join(srcDir, "retry.ts"))).toBe(true);
  });

  it("links component dependencies to real library components only", () => {
    const a = makeComponent();
    expect(() =>
      lib.components.create({ name: "B", category: "networking", sources: [srcDir], dependencies: [{ type: "component", name: "missing" }] }),
    ).toThrow(/does not match any component/);
    const b = lib.components.create({ name: "B", category: "networking", sources: [srcDir], dependencies: [{ type: "component", name: a.slug }] });
    expect(b.dependencies[0].dependsOnComponentId).toBe(a.id);
  });
});

describe("projects", () => {
  it("registers an existing folder and links components both ways", () => {
    const c = makeComponent();
    const p = lib.projects.register({ path: projDir });
    expect(p.name).toBe("app-one");
    expect(p.path).toBe(projDir);
    expect(() => lib.projects.register({ path: projDir })).toThrow(/already registered/);
    expect(() => lib.projects.register({ path: path.join(srcDir, "retry.ts") })).toThrow(/is a file, but a directory/);

    lib.projects.link(p.id, c.slug, "used for API calls");
    expect(() => lib.projects.link(p.id, c.slug)).toThrow(/already uses/);
    expect(lib.projects.get(p.id).components).toEqual([expect.objectContaining({ slug: c.slug, note: "used for API calls" })]);
    expect(lib.components.get(c.id).projects).toEqual([expect.objectContaining({ projectId: p.id, projectName: "app-one" })]);

    expect(fs.readdirSync(projDir)).toEqual([]); // project folder untouched
    lib.projects.unregister(p.id);
    expect(fs.existsSync(projDir)).toBe(true);
    expect(lib.components.get(c.id).projects).toEqual([]);
  });
});

describe("tests", () => {
  it("runs the real command and records pass, fail, and timeout", async () => {
    const c = makeComponent({ testCommand: "ls retry.ts && echo hello" });
    expect(lib.components.get(c.id).lastTestStatus).toBeNull();

    const pass = await lib.tests.run(c.id);
    expect(pass).toMatchObject({ status: "passed", exitCode: 0, cwd: srcDir });
    expect(pass.stdout).toContain("hello");

    lib.components.update(c.id, { testCommand: "echo boom >&2; exit 3" });
    const fail = await lib.tests.run(c.id);
    expect(fail).toMatchObject({ status: "failed", exitCode: 3 });
    expect(fail.stderr).toContain("boom");

    lib.settings.update({ testTimeoutSeconds: 1 });
    lib.components.update(c.id, { testCommand: "sleep 5" });
    const slow = await lib.tests.run(c.id);
    expect(slow.status).toBe("timeout");
    expect(slow.durationMs).toBeLessThan(4000);

    expect(lib.tests.list(c.id).map((r) => r.status)).toEqual(["timeout", "failed", "passed"]);
    expect(lib.components.get(c.id).lastTestStatus).toBe("timeout");
  });

  it("refuses to run when no command is set, without recording a result", async () => {
    const c = makeComponent();
    await expect(lib.tests.run(c.id)).rejects.toThrow(/no test command/);
    expect(lib.tests.list(c.id)).toEqual([]);
  });
});

describe("recent", () => {
  it("lists components by latest activity", () => {
    const c = makeComponent();
    lib.components.markViewed(c.id);
    expect(lib.components.recent()[0]).toMatchObject({ id: c.id, lastAction: "viewed" });
  });
});

describe("settings", () => {
  it("rejects unsafe allowed folders", () => {
    expect(() => lib.settings.update({ allowedRoots: ["/"] })).toThrow(/whole disk/);
    expect(() => lib.settings.update({ allowedRoots: [] })).toThrow(/At least one/);
    expect(() => lib.settings.update({ allowedRoots: ["rel"] })).toThrow(/absolute/);
  });
});

// keep the import used even if createLibrary is only re-exported
void createLibrary;
