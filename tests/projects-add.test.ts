/**
 * Add project: "Create project" (with the stand-in AI) and "Add existing
 * project" (no AI). Throwaway database, data folder and project folders only.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLibrary, type Library } from "../src/core";
import { iCloudWarning } from "../src/core/settings";

const FAKE = `node ${path.resolve(import.meta.dirname, "create/fake-generator.mjs")}`;
let tmp: string;
let lib: Library;
const env = { ...process.env };

const tree = (dir: string) => {
  const h = crypto.createHash("sha256");
  const walk = (d: string) => { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n); const st = fs.lstatSync(f); h.update(`${path.relative(dir, f)}:${st.mode}:${st.mtimeMs}`); if (st.isDirectory()) walk(f); else h.update(fs.readFileSync(f)); } };
  walk(dir);
  return h.digest("hex");
};
const write = (rel: string, text: string) => { const f = path.join(tmp, "code", rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cl-projects-")));
  process.env.COMPONENT_LIBRARY_HOME = path.join(tmp, "home");
  process.env.COMPONENT_LIBRARY_CODE_DIR = path.join(tmp, "shared");
  process.env.COMPONENT_LIBRARY_GENERATOR = FAKE;
  lib = openLibrary(path.join(tmp, "home", "library.db"));
  lib.settings.update({ allowedRoots: [path.join(tmp)], projectsRoot: path.join(tmp, "Projects") });
  write("shop-site/package.json", JSON.stringify({ name: "@me/shop-site", description: "The shop's website." }));
  write("shop-site/README.md", "# Shop\n\nNot this one.\n");
  write("shop-site/.git/HEAD", "ref: refs/heads/main\n");
  write("mailer/pyproject.toml", '[project]\nname = "mail-sorter"\ndescription = "Sorts incoming mail into folders."\n');
  write("notes/README.md", "# Notes\n\n[![badge](x.svg)](y)\n\nA place for **meeting notes**, sorted by [date](https://x).\n\nMore text.\n");
  write("plain-folder/data.txt", "x");
  write(".hidden-thing/README.md", "secret");
});

afterEach(() => {
  lib.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of ["COMPONENT_LIBRARY_HOME", "COMPONENT_LIBRARY_CODE_DIR", "COMPONENT_LIBRARY_GENERATOR"]) {
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
});

describe("add existing project", () => {
  it("browses only inside the allowed folders, folder names only, hidden ones left out", () => {
    expect(lib.folders.list().folders.map((f) => f.path)).toEqual([tmp]); // the top level is the allowed folders
    const code = lib.folders.list(path.join(tmp, "code"));
    expect(code.folders.map((f) => f.name)).toEqual(["mailer", "notes", "plain-folder", "shop-site"]);
    expect(code.folders.find((f) => f.name === "shop-site")!.looksLikeProject).toBe(true);
    expect(code.folders.find((f) => f.name === "plain-folder")!.looksLikeProject).toBe(false);
    expect(code.parent).toBe(tmp);
    expect(lib.folders.list(tmp).parent).toBeNull(); // can't go above an allowed folder
    expect(() => lib.folders.list("/usr")).toThrow(/outside the allowed folders/);
    expect(() => lib.folders.list(path.join(tmp, "code", "nope"))).toThrow(/Nothing exists/);
  });

  it("suggests a name and description from the project file or README, and changes nothing", () => {
    const before = tree(path.join(tmp, "code"));
    expect(lib.folders.inspect(path.join(tmp, "code", "shop-site"))).toMatchObject({
      name: "Shop Site", description: "The shop's website.", sources: ["package.json"], technology: ["Node.js"], git: true, duplicate: null,
    });
    expect(lib.folders.inspect(path.join(tmp, "code", "mailer"))).toMatchObject({ name: "Mail Sorter", description: "Sorts incoming mail into folders.", technology: ["Python"] });
    expect(lib.folders.inspect(path.join(tmp, "code", "notes"))).toMatchObject({ name: "Notes", description: "A place for meeting notes, sorted by date.", sources: ["the README", "the folder name"] });
    expect(lib.folders.inspect(path.join(tmp, "code", "plain-folder"))).toMatchObject({ name: "Plain Folder", description: "", technology: [] });
    expect(tree(path.join(tmp, "code"))).toBe(before);
  });

  it("detects a folder already in the library, and overlapping ones", () => {
    const shop = path.join(tmp, "code", "shop-site");
    lib.projects.register({ path: shop, name: "Shop" });
    expect(lib.folders.inspect(shop).duplicate).toMatchObject({ name: "Shop" });
    expect(lib.folders.list(path.join(tmp, "code")).folders.find((f) => f.name === "shop-site")!.registeredAs).toBe("Shop");
    expect(lib.folders.inspect(path.join(tmp, "code")).overlaps).toEqual([expect.objectContaining({ relation: "inside", project: expect.objectContaining({ name: "Shop" }) })]);
    expect(() => lib.projects.register({ path: shop, name: "Shop again" })).toThrow(/already registered as "Shop"/);
  });

  it("works without any AI", () => {
    process.env.COMPONENT_LIBRARY_GENERATOR = "exit 1";
    const s = lib.folders.inspect(path.join(tmp, "code", "mailer"));
    const p = lib.projects.register({ path: s.path, name: s.name, description: s.description });
    expect(lib.projects.get(p.id)).toMatchObject({ name: "Mail Sorter", description: "Sorts incoming mail into folders." });
  });
});

/** Plan, then match components: the draft as it is at the Components step. */
async function planned(text: string) {
  const d = await lib.projectCreation.start(text);
  await lib.projectCreation.analyze(d.id);
  return lib.projectCreation.get(d.id);
}

describe("create project (no components)", () => {
  it("plans, builds in staging, and creates the folder and files only on approval, then adds the project", async () => {
    const d = await planned("A tool that plans my meals for the week");
    expect(d.analysis!.files.map((f) => f.path)).toEqual(["README.md", "app.py", "tests/test_app.py"]);
    expect(d.plan!.name).toBe("Weekly Dashboard");
    expect(d.choice.folder).toBe("weekly-dashboard");
    expect(d.analysis!.components).toEqual([]); // the library has none, so none are recommended
    expect(fs.existsSync(path.join(tmp, "Projects"))).toBe(false); // nothing on disk before approval
    lib.projectCreation.savePlan(d.id, { name: "Meal Planner", description: d.plan!.description, features: d.plan!.features });
    lib.projectCreation.folder(d.id, "meal-planner");
    await lib.projectCreation.build(d.id);
    await lib.projectCreation.test(d.id);
    expect(fs.existsSync(path.join(tmp, "Projects"))).toBe(false); // built in staging only
    await lib.projectCreation.create(d.id);
    const made = path.join(tmp, "Projects", "meal-planner");
    expect(fs.readdirSync(made).sort()).toEqual(["README.md", "app.py", "tests"]);
    const after = lib.projectCreation.get(d.id);
    expect(lib.projects.get(after.project!.id)).toMatchObject({ name: "Meal Planner", path: made, components: [] });
    expect(lib.components.search("").length).toBe(0);
    expect(lib.projectCreation.list()).toEqual([]);
    await expect(lib.projectCreation.create(d.id)).rejects.toThrow(/already been created/);
  });

  it("never overwrites an existing folder", async () => {
    const d = await planned("A tool that plans my meals for the week");
    const target = path.join(tmp, "Projects", "weekly-dashboard");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "mine.txt"), "keep me");
    expect(lib.projectCreation.readyToBuild(lib.projectCreation.get(d.id)).join(" ")).toMatch(/already exists.*never overwritten/);
    await expect(lib.projectCreation.build(d.id)).rejects.toThrow(/already exists/);
    await expect(lib.projectCreation.create(d.id)).rejects.toThrow(/already exists/);
    expect(fs.readdirSync(target)).toEqual(["mine.txt"]);
    expect(lib.projects.list()).toEqual([]);
  });

  it("refuses files outside the project, and anything that looks like a secret", async () => {
    const bad = await planned("Plan meals [bad-file]");
    await expect(lib.projectCreation.build(bad.id)).rejects.toThrow(/"\.\.\/outside\.txt": only plain relative paths/);
    const leaky = await planned("Plan meals [secret]");
    lib.projectCreation.folder(leaky.id, "leaky");
    await lib.projectCreation.build(leaky.id);
    expect(lib.projectCreation.get(leaky.id).build!.problems.join(" ")).toMatch(/look like a password, key or webhook \(config\.py:1\)/);
    await expect(lib.projectCreation.create(leaky.id)).rejects.toThrow(/password, key or webhook/);
    expect(fs.existsSync(path.join(tmp, "Projects", "leaky"))).toBe(false);
  });

  it("only creates inside an allowed folder", async () => {
    const d = await planned("A tool that plans my meals for the week");
    expect(() => lib.settings.update({ projectsRoot: "/usr/local/projects" })).toThrow(/inside an allowed folder/);
    lib.db.prepare("UPDATE settings SET value = ? WHERE key = 'projectsRoot'").run(JSON.stringify("/usr/local/projects")); // as if changed outside the app
    expect(lib.projectCreation.readyToBuild(lib.projectCreation.get(d.id)).join(" ")).toMatch(/outside your allowed folders/);
    await expect(lib.projectCreation.build(d.id)).rejects.toThrow(/outside your allowed folders/);
  });

  it("a failed plan is kept and can be retried; a plan can be discarded without creating anything", async () => {
    const d = await lib.projectCreation.start("Plan meals [fail-project]");
    expect(d.plan).toBeNull();
    expect(d.lastError!.message).toMatch(/model overloaded/);
    const ok = await lib.projectCreation.start("A tool that plans my meals for the week");
    lib.projectCreation.discard(ok.id);
    expect(() => lib.projectCreation.get(ok.id)).toThrow(/not found/i);
    expect(fs.existsSync(path.join(tmp, "Projects"))).toBe(false);
  });

  it("checks folder names, and warns about iCloud folders", async () => {
    const d = await lib.projectCreation.start("A tool that plans my meals for the week");
    expect(() => lib.projectCreation.folder(d.id, "../escape")).toThrow(/Folder names use lowercase/);
    expect(() => lib.projectCreation.folder(d.id, "Has Spaces")).toThrow(/Folder names use lowercase/);
    expect(iCloudWarning(path.join(os.homedir(), "Desktop", "projects"))).toMatch(/syncs with iCloud/);
    expect(iCloudWarning(path.join(os.homedir(), "Projects"))).toBeNull();
  });
});
