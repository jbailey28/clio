/**
 * Deleting and removing: "delete" must be typed for the big ones, files only
 * ever go to the Trash (never deleted outright), only files the library owns
 * or the chosen folder are moved, and a failure puts everything back.
 * Throwaway library, folders and Trash only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLibrary, type Library } from "../src/core";
import { unlockTree } from "../src/core/releases";
import { sandboxedPythonTestCommand } from "../src/core/sandbox";

let tmp: string;
let lib: Library;
let trash: string;
const env = { ...process.env };
const inTrash = () => (fs.existsSync(trash) ? fs.readdirSync(trash).sort() : []);

/** A packaged component (its files are kept by the library) with a 1.0.0 release. */
async function packaged() {
  const src = path.join(tmp, "src", "weekly-stats");
  fs.mkdirSync(path.join(src, "weekly_stats"), { recursive: true });
  fs.mkdirSync(path.join(src, "tests"), { recursive: true });
  fs.writeFileSync(path.join(src, "weekly_stats", "__init__.py"), "def summarize(rows):\n    return len(rows)\n");
  fs.writeFileSync(path.join(src, "tests", "test_w.py"), "import unittest\nfrom weekly_stats import summarize\n\n\nclass T(unittest.TestCase):\n    def test_s(self):\n        self.assertEqual(summarize([1]), 1)\n");
  const { component } = lib.components.createPackaged({ name: "Weekly Stats", category: "data", sources: [src], language: "Python", summary: "Counts rows.", testCommand: sandboxedPythonTestCommand() });
  expect((await lib.tests.run(component.id)).status).toBe("passed");
  lib.releases.create(component.id, { version: "1.0.0", changes: "First." });
  return lib.components.get(component.id);
}

function project(name = "app") {
  const dir = path.join(tmp, "Projects", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "main.py"), "print('hi')\n");
  return lib.projects.register({ path: dir, name });
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cl-removal-")));
  trash = path.join(tmp, "Trash");
  process.env.COMPONENT_LIBRARY_HOME = path.join(tmp, "home");
  process.env.COMPONENT_LIBRARY_CODE_DIR = path.join(tmp, "shared");
  process.env.COMPONENT_LIBRARY_TRASH = trash;
  lib = openLibrary(path.join(tmp, "home", "library.db"));
  lib.settings.update({ allowedRoots: [tmp], projectsRoot: path.join(tmp, "Projects") });
  lib.categories.create({ name: "Data" });
});

afterEach(() => {
  lib.db.close();
  for (const d of [path.join(tmp, "shared"), trash]) if (fs.existsSync(d)) unlockTree(d);
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of ["COMPONENT_LIBRARY_HOME", "COMPONENT_LIBRARY_CODE_DIR", "COMPONENT_LIBRARY_TRASH"]) {
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
});

describe("removing a project", () => {
  it("needs delete typed, and by default leaves the folder alone", () => {
    const p = project();
    expect(() => lib.removal.removeProject(p.id, { confirm: "app" })).toThrow(/type "delete"/);
    expect(lib.projects.list()).toHaveLength(1);
    lib.removal.removeProject(p.id, { confirm: "Delete " });
    expect(lib.projects.list()).toEqual([]);
    expect(fs.existsSync(path.join(tmp, "Projects", "app", "main.py"))).toBe(true);
    expect(inTrash()).toEqual([]);
  });

  it("can move the folder to the Trash, never deleting it", () => {
    const p = project();
    const r = lib.removal.removeProject(p.id, { confirm: "delete", trashFolder: true });
    expect(fs.existsSync(path.join(tmp, "Projects", "app"))).toBe(false);
    expect(fs.readFileSync(path.join(r.trashed!, "main.py"), "utf8")).toBe("print('hi')\n");
    expect(lib.projects.list()).toEqual([]);
    const again = project(); // same name again: the Trash keeps both
    lib.removal.removeProject(again.id, { confirm: "delete", trashFolder: true });
    expect(inTrash()).toEqual(["app", "app 2"]);
  });

  it("won't send a folder holding other things to the Trash", () => {
    const outer = project("outer");
    const inner = lib.projects.register({ path: fs.mkdirSync(path.join(tmp, "Projects", "outer", "inner"), { recursive: true })!, name: "inner" });
    expect(lib.removal.projectFolder(outer.id)).toMatchObject({ canTrash: false, why: expect.stringMatching(/"inner", is inside it/) });
    expect(lib.removal.projectFolder(inner.id).why).toMatch(/"outer", is around it/);
    expect(() => lib.removal.removeProject(outer.id, { confirm: "delete", trashFolder: true })).toThrow(/can't be moved to the Trash.*Nothing was changed/);
    expect(lib.projects.list()).toHaveLength(2);
    const root = lib.projects.register({ path: path.join(tmp, "Projects"), name: "everything" });
    expect(lib.removal.projectFolder(root.id).why).toMatch(/whole folder of your files|is inside it/);
    expect(inTrash()).toEqual([]);
  });

  it("if the library can't be updated, the folder comes back out of the Trash", () => {
    const p = project();
    lib.db.exec(`CREATE TRIGGER no_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`);
    expect(() => lib.removal.removeProject(p.id, { confirm: "delete", trashFolder: true })).toThrow(/simulated failure/);
    expect(fs.existsSync(path.join(tmp, "Projects", "app", "main.py"))).toBe(true);
    expect(inTrash()).toEqual([]);
  });
});

describe("deleting a component", () => {
  it("needs delete typed, is refused while a project uses it, and by default keeps every file", async () => {
    const c = await packaged();
    const files = lib.removal.componentFiles(c.id);
    expect(files.library.map((f) => path.relative(path.join(tmp, "shared"), f)).sort()).toEqual(["releases/weekly-stats", "weekly-stats"]);
    const p = project();
    lib.projects.link(p.id, c.id, "uses it");
    expect(() => lib.removal.removeComponent(c.id, { confirm: "delete" })).toThrow(/used by app/);
    lib.projects.unlink(p.id, c.id);
    expect(() => lib.removal.removeComponent(c.id, { confirm: "weekly-stats" })).toThrow(/type "delete"/);
    lib.removal.removeComponent(c.id, { confirm: "delete" });
    expect(lib.components.search("")).toEqual([]);
    expect(files.library.every((f) => fs.existsSync(f))).toBe(true);
  });

  it("can move the library's files for it, saved versions included, to the Trash", async () => {
    const c = await packaged();
    const r = lib.removal.removeComponent(c.id, { confirm: "delete", trashFiles: true });
    expect(r.trashed).toHaveLength(2);
    expect(fs.existsSync(path.join(tmp, "shared", "weekly-stats"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "shared", "releases", "weekly-stats"))).toBe(false);
    expect(inTrash().sort()).toEqual(["weekly-stats", "weekly-stats 2"]);
  });

  it("never touches files that live outside the library", () => {
    const dir = path.join(tmp, "other-project", "lib");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "x.py"), "x = 1\n");
    const c = lib.components.create({ name: "Borrowed", category: "data", sources: [dir], summary: "Lives in another project." });
    expect(lib.removal.componentFiles(c.id)).toEqual({ library: [], elsewhere: [dir] });
    lib.removal.removeComponent(c.id, { confirm: "delete", trashFiles: true });
    expect(fs.existsSync(path.join(dir, "x.py"))).toBe(true);
    expect(inTrash()).toEqual([]);
  });

  it("if the library can't be updated, its files come back, still read-only", async () => {
    const c = await packaged();
    lib.db.exec(`CREATE TRIGGER no_delete BEFORE DELETE ON components BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`);
    expect(() => lib.removal.removeComponent(c.id, { confirm: "delete", trashFiles: true })).toThrow(/simulated failure/);
    const rel = path.join(tmp, "shared", "releases", "weekly-stats");
    expect(fs.existsSync(rel) && fs.existsSync(path.join(tmp, "shared", "weekly-stats"))).toBe(true);
    expect(fs.statSync(rel).mode & 0o222).toBe(0);
    expect(inTrash()).toEqual([]);
  });
});

describe("removing a component from a project", () => {
  it("keeps the project's copy unless asked, and moving it needs delete typed", async () => {
    const c = await packaged();
    const p = project();
    lib.integration.add(p.id, c.id, "1.0.0");
    const copy = lib.removal.projectCopy(p.id, c.id)!;
    expect(copy).toBe(path.join(tmp, "Projects", "app", "components", "weekly-stats"));
    expect(() => lib.removal.removeFromProject(p.id, c.id, { trashCopy: true, confirm: "" })).toThrow(/type "delete"/);
    expect(lib.projects.get(p.id).components).toHaveLength(1);
    lib.removal.removeFromProject(p.id, c.id, { trashCopy: true, confirm: "delete" });
    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.existsSync(path.join(tmp, "Projects", "app", "main.py"))).toBe(true); // nothing else in the project
    expect(lib.projects.get(p.id).components).toEqual([]);
    expect(inTrash()).toEqual(["weekly-stats"]);
  });

  it("without the choice, nothing on disk changes", async () => {
    const c = await packaged();
    const p = project();
    lib.integration.add(p.id, c.id, "1.0.0");
    lib.removal.removeFromProject(p.id, c.id);
    expect(fs.existsSync(path.join(tmp, "Projects", "app", "components", "weekly-stats"))).toBe(true);
  });
});
