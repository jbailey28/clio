/**
 * Building projects from library components: plans grounded in the real code,
 * real copies of releases, sandboxed tests that prove the project calls each
 * component, records written only with the files, and Added vs Connected for
 * existing projects. Stand-in AI (tests/create/fake-generator.mjs), throwaway
 * library and folders only.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLibrary, type Library } from "../src/core";
import { treeChecksum, unlockTree } from "../src/core/releases";
import { sandboxedPythonTestCommand } from "../src/core/sandbox";

const FAKE = `node ${path.resolve(import.meta.dirname, "create/fake-generator.mjs")}`;
let tmp: string;
let lib: Library;
const env = { ...process.env };
const hash = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

/** A real component with a real 1.0.0 release: reads exported rows, no network. */
async function weeklyStats() {
  const src = path.join(tmp, "src", "weekly-stats");
  fs.mkdirSync(path.join(src, "weekly_stats"), { recursive: true });
  fs.mkdirSync(path.join(src, "tests"), { recursive: true });
  fs.writeFileSync(path.join(src, "weekly_stats", "__init__.py"), `"""Weekly numbers from exported rows."""
import csv

__all__ = ["summarize", "read_export"]


def summarize(rows):
    """Total posts and likes from rows of an export."""
    return {"posts": len(rows), "likes": sum(int(r.get("likes") or 0) for r in rows)}


def read_export(path):
    """Rows from an exported CSV file."""
    with open(path, newline="") as f:
        return list(csv.DictReader(f))
`);
  fs.writeFileSync(path.join(src, "tests", "test_weekly_stats.py"), `import unittest
from weekly_stats import summarize


class T(unittest.TestCase):
    def test_summarize(self):
        self.assertEqual(summarize([{"likes": "2"}, {"likes": "3"}]), {"posts": 2, "likes": 5})
`);
  const { component } = lib.components.createPackaged({ name: "Weekly Stats", category: "data", sources: [src], language: "Python", summary: "Totals posts and likes from exported Instagram rows.",
    capabilities: [{ name: "Weekly totals", description: "Posts and likes from exported rows" }], testCommand: sandboxedPythonTestCommand() });
  expect((await lib.tests.run(component.id)).status).toBe("passed");
  lib.releases.create(component.id, { version: "1.0.0", changes: "First release." });
  return lib.components.get(component.id);
}

/** A second component, with network use, that has nothing to do with dashboards. */
function websiteReader() {
  const dir = path.join(tmp, "src", "site-reader", "site_reader");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "__init__.py"), `import urllib.request\n\n\ndef fetch(url):\n    """Read one page."""\n    return urllib.request.urlopen(url).read()\n`);
  const c = lib.components.create({ name: "Site Reader", category: "data", sources: [path.dirname(dir)], language: "Python", summary: "Fetches a web page." });
  const snap = lib.releases.snapshot({ slug: c.slug, version: "1.0.0", from: path.dirname(dir) });
  lib.releases.record(c.id, { version: "1.0.0", path: snap.path, changes: "First." });
  return c;
}

/** Plan, then match components: the draft as it is at the Components step. */
async function planned(text: string) {
  const d = await lib.projectCreation.start(text);
  await lib.projectCreation.analyze(d.id);
  return lib.projectCreation.get(d.id);
}

/** Plan, build and test a dashboard that uses weekly-stats; returns the draft id. */
async function testedDraft(extra = "") {
  const d = await planned(`A dashboard of my weekly Instagram numbers [use:weekly-stats] ${extra}`);
  await lib.projectCreation.build(d.id);
  await lib.projectCreation.test(d.id);
  return d.id;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cl-integration-")));
  process.env.COMPONENT_LIBRARY_HOME = path.join(tmp, "home");
  process.env.COMPONENT_LIBRARY_CODE_DIR = path.join(tmp, "shared");
  process.env.COMPONENT_LIBRARY_GENERATOR = FAKE;
  lib = openLibrary(path.join(tmp, "home", "library.db"));
  lib.settings.update({ allowedRoots: [tmp], projectsRoot: path.join(tmp, "Projects") });
  lib.categories.create({ name: "Data" });
});

afterEach(() => {
  lib.db.close();
  for (const d of [path.join(tmp, "shared", "releases")]) if (fs.existsSync(d)) unlockTree(d);
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of ["COMPONENT_LIBRARY_HOME", "COMPONENT_LIBRARY_CODE_DIR", "COMPONENT_LIBRARY_GENERATOR"]) {
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
});

describe("planning from the real code", () => {
  it("reads the release's real functions and behavior", async () => {
    await weeklyStats();
    const ins = lib.integration.inspect("weekly-stats");
    expect(ins.packages).toEqual([{ name: "weekly_stats", importRoot: "weekly-stats" }]);
    expect(ins.api.map((f) => `${f.name}${f.signature}`)).toEqual(["summarize(rows)", "read_export(path)"]);
    expect(ins).toMatchObject({ usesNetwork: false, readsFiles: true, writesFiles: false, release: "intact" });
    websiteReader();
    expect(lib.integration.inspect("site-reader").usesNetwork).toBe(true);
  });

  it("inspects every component but shows only the ones recommended, with their evidence", async () => {
    await weeklyStats();
    websiteReader();
    const d = await planned("A dashboard of my weekly Instagram numbers [use:weekly-stats] [ghost]");
    const p = d.analysis!;
    expect(p.components.map((c) => c.slug)).toEqual(["weekly-stats"]); // site-reader was inspected, not recommended; the made-up one is dropped
    expect(p.needs.find((n) => n.need === "Imaginary")!.status).toBe("build"); // a need pointed at a missing component is built instead, never invented
    expect(p.components[0]).toMatchObject({ version: "1.0.0", packages: ["weekly_stats"], uses: ["summarize"], problems: [],
      evidence: { network: false, readsFiles: true, testStatus: "passed", release: "intact", functions: [{ name: "summarize", signature: "(rows)", doc: "Total posts and likes from rows of an export." }] } });
    expect(p.components[0].missing).toMatch(/doesn't collect anything from Instagram/);
    expect(p.needs.find((n) => n.status === "setup")!.need).toBe("Monday email");
    expect(lib.projectCreation.included(d).map((c) => c.slug)).toEqual(["weekly-stats"]);
  });

  it("a recommendation naming a function the code doesn't have is flagged and can't be included", async () => {
    await weeklyStats();
    const d = await planned("Dashboard [use:weekly-stats] [fn:collect_from_instagram]");
    expect(d.analysis!.components[0].problems.join(" ")).toMatch(/no public collect_from_instagram/);
    expect(lib.projectCreation.included(d)).toEqual([]);
  });
});

describe("building and testing a new project with components", () => {
  it("copies the release unchanged, calls it from the project's code, and proves it in the sandbox", async () => {
    const c = await weeklyStats();
    const id = await testedDraft();
    const d = lib.projectCreation.get(id);
    const build = path.join(tmp, "home", "staging", id, "build", "weekly-dashboard");
    const release = lib.releases.get(c.id, "1.0.0");
    expect(treeChecksum(path.join(build, "components", "weekly-stats")).checksum).toBe(release.checksum);
    expect(fs.readFileSync(path.join(build, "component_paths.py"), "utf8")).toContain('["components/weekly-stats/weekly-stats"]');
    expect(d.build!.usage["weekly-stats"]).toEqual({ imported: true, called: ["summarize"] });
    expect(d.build!.problems).toEqual([]);
    expect(d.tests!.status, d.tests!.stderr).toBe("passed");
    expect(d.tests!.stderr).toMatch(/test_each_copy_is_its_release/); // the match-check ran too
    expect(d.tests!.calls).toEqual({ "weekly-stats": ["summarize"] });
    expect(lib.projectCreation.connections(d)["weekly-stats"]).toMatchObject({ connected: true });
    expect(fs.existsSync(path.join(tmp, "Projects"))).toBe(false); // still only in staging
  });

  it("creates the folder, then records the project and its connected component at the exact version", async () => {
    const c = await weeklyStats();
    const id = await testedDraft();
    await lib.projectCreation.create(id);
    const made = path.join(tmp, "Projects", "weekly-dashboard");
    const d = lib.projectCreation.get(id);
    expect(treeChecksum(made).checksum).toBe(treeChecksum(path.join(tmp, "home", "staging", id, "build", "weekly-dashboard")).checksum);
    const p = lib.projects.get(d.project!.id);
    expect(p.components).toEqual([expect.objectContaining({ slug: "weekly-stats", version: "1.0.0", integration: "connected" })]);
    expect(p.components[0].integrationDetail).toMatch(/calls summarize.*passing tests called summarize/);
    expect(lib.releases.verify(c.id, "1.0.0").state).toBe("intact"); // the release itself untouched
  });

  it("a component left out isn't copied, called or linked", async () => {
    await weeklyStats();
    const d = await planned("Dashboard [use:weekly-stats]");
    lib.projectCreation.choose(d.id, { useComponent: { "weekly-stats": false } });
    await lib.projectCreation.build(d.id);
    const after = lib.projectCreation.get(d.id);
    expect(after.build!.files.some((f) => f.path.startsWith("components/"))).toBe(false);
    expect(after.build!.problems).toEqual([]);
    await lib.projectCreation.test(d.id);
    await lib.projectCreation.create(d.id);
    expect(lib.projects.get(lib.projectCreation.get(d.id).project!.id).components).toEqual([]);
  });

  it("code that imports a component but never calls it is refused before anything runs", async () => {
    await weeklyStats();
    const d = await planned("Dashboard [use:weekly-stats] [no-call]");
    await lib.projectCreation.build(d.id);
    expect(lib.projectCreation.get(d.id).build!.problems.join(" ")).toMatch(/imports Weekly Stats but never calls/);
    await expect(lib.projectCreation.test(d.id)).rejects.toThrow(/won't be run|will not be run/);
    await lib.projectCreation.build(d.id, "Call it, please.");
    expect(lib.projectCreation.get(d.id).build!.problems).toEqual([]); // Fix with AI repaired it
  });

  it("tests that pass without calling the component don't count as connected", async () => {
    await weeklyStats();
    const id = await testedDraft("[test-not-calling]");
    const d = lib.projectCreation.get(id);
    expect(d.tests!.status).toBe("passed");
    expect(lib.projectCreation.connections(d)["weekly-stats"]).toMatchObject({ connected: false, why: expect.stringMatching(/never called it/) });
    expect(lib.projectCreation.ready(d).problems.join(" ")).toMatch(/Weekly Stats isn't connected/);
    await expect(lib.projectCreation.create(id)).rejects.toThrow(/isn't connected/);
    expect(fs.existsSync(path.join(tmp, "Projects", "weekly-dashboard"))).toBe(false);
  });

  it("failing tests block creation", async () => {
    await weeklyStats();
    const id = await testedDraft("[failing-tests]");
    expect(lib.projectCreation.get(id).tests!.status).toBe("failed");
    await expect(lib.projectCreation.create(id)).rejects.toThrow(/tests failed/);
  });

  it("a release that changed after planning can't be copied", async () => {
    const c = await weeklyStats();
    const d = await planned("Dashboard [use:weekly-stats]");
    const rel = lib.releases.get(c.id, "1.0.0").sourcePath;
    const f = path.join(rel, "weekly-stats", "weekly_stats", "__init__.py");
    unlockTree(rel);
    fs.appendFileSync(f, "\n# tampered\n");
    expect(lib.projectCreation.readyToBuild(lib.projectCreation.get(d.id)).join(" ")).toMatch(/no longer match their checksum/);
    await expect(lib.projectCreation.build(d.id)).rejects.toThrow(/no longer match/);
  });
});

describe("creating is all or nothing", () => {
  it("if recording fails, the folder is removed and nothing is recorded", async () => {
    await weeklyStats();
    const id = await testedDraft();
    lib.db.exec(`CREATE TRIGGER fail_link BEFORE INSERT ON project_components BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`);
    await expect(lib.projectCreation.create(id)).rejects.toThrow(/simulated failure/);
    expect(fs.existsSync(path.join(tmp, "Projects", "weekly-dashboard"))).toBe(false);
    expect(lib.projects.list()).toEqual([]); // the project row was rolled back with the failed link
    expect(lib.projectCreation.get(id).project).toBeNull();
    lib.db.exec("DROP TRIGGER fail_link");
    await lib.projectCreation.create(id); // and it can be retried
    expect(lib.projects.list().length).toBe(1);
  });

  it("if writing the files fails, nothing is recorded and the half-made folder is removed", async () => {
    await weeklyStats();
    const id = await testedDraft();
    const staged = path.join(tmp, "home", "staging", id, "build", "weekly-dashboard", "app.py");
    fs.chmodSync(staged, 0o000);
    try { await expect(lib.projectCreation.create(id)).rejects.toThrow(); } finally { fs.chmodSync(staged, 0o644); }
    expect(fs.existsSync(path.join(tmp, "Projects", "weekly-dashboard"))).toBe(false);
    expect(lib.projects.list()).toEqual([]);
  });
});

describe("existing projects: Added and Connected", () => {
  function existingProject() {
    const dir = path.join(tmp, "my-app");
    fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
    fs.writeFileSync(path.join(dir, "app.py"), "def hello():\n    return 'hi'\n");
    fs.writeFileSync(path.join(dir, "tests", "test_app.py"), "import unittest\nimport app\n\n\nclass T(unittest.TestCase):\n    def test_hello(self):\n        self.assertEqual(app.hello(), 'hi')\n");
    return { dir, p: lib.projects.register({ path: dir, name: "My App" }) };
  }

  it("adding copies the release into a new folder and changes nothing else", async () => {
    const c = await weeklyStats();
    const { dir, p } = existingProject();
    const before = { app: hash(path.join(dir, "app.py")), test: hash(path.join(dir, "tests", "test_app.py")) };
    const preview = lib.integration.preview(p.id, "weekly-stats");
    expect(preview).toMatchObject({ version: "1.0.0", problems: [], dest: path.join(dir, "components", "weekly-stats") });
    expect(preview.snippet).toContain("from weekly_stats import summarize, read_export");
    lib.integration.add(p.id, "weekly-stats");
    expect(treeChecksum(path.join(dir, "components", "weekly-stats")).checksum).toBe(lib.releases.get(c.id, "1.0.0").checksum);
    expect({ app: hash(path.join(dir, "app.py")), test: hash(path.join(dir, "tests", "test_app.py")) }).toEqual(before);
    expect(fs.readdirSync(dir).sort()).toEqual(["app.py", "components", "tests"]); // nothing else added
    expect(lib.projects.get(p.id).components[0]).toMatchObject({ slug: "weekly-stats", version: "1.0.0", integration: "added" });
    expect(lib.integration.preview(p.id, "weekly-stats").problems.join(" ")).toMatch(/already exists/);
    expect(() => lib.integration.add(p.id, "weekly-stats")).toThrow(/already exists/);
  });

  it("stays Added until the project's own tests call it, then becomes Connected", async () => {
    await weeklyStats();
    const { dir, p } = existingProject();
    lib.integration.add(p.id, "weekly-stats");
    let r = await lib.integration.check(p.id, "weekly-stats");
    expect(r).toMatchObject({ integration: "added", detail: expect.stringMatching(/never called the component/) });
    // The person wires it in (the library never edits their files).
    fs.writeFileSync(path.join(dir, "stats.py"), `import os, sys\nsys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "components/weekly-stats/weekly-stats"))\nfrom weekly_stats import summarize\n\n\ndef likes(rows):\n    return summarize(rows)["likes"]\n`);
    fs.writeFileSync(path.join(dir, "tests", "test_stats.py"), "import unittest\nimport stats\n\n\nclass S(unittest.TestCase):\n    def test_likes(self):\n        self.assertEqual(stats.likes([{'likes': '4'}]), 4)\n");
    r = await lib.integration.check(p.id, "weekly-stats");
    expect(r).toMatchObject({ integration: "connected", detail: expect.stringMatching(/called summarize/) });
    expect(lib.projects.get(p.id).components[0].integration).toBe("connected");
  });

  it("a changed copy, or a project with no tests, is never called Connected", async () => {
    const c = await weeklyStats();
    const { dir, p } = existingProject();
    lib.integration.add(p.id, "weekly-stats");
    fs.rmSync(path.join(dir, "tests"), { recursive: true });
    expect((await lib.integration.check(p.id, "weekly-stats")).detail).toMatch(/no tests/);
    fs.appendFileSync(path.join(dir, "components", "weekly-stats", "weekly-stats", "weekly_stats", "__init__.py"), "\n# edited\n");
    expect(await lib.integration.check(p.id, "weekly-stats")).toMatchObject({ integration: "added", detail: expect.stringMatching(/no longer matches Weekly Stats 1\.0\.0/) });
    expect(lib.releases.verify(c.id, "1.0.0").state).toBe("intact");
  });

  it("a link recorded by hand stays Recorded; nothing claims more than was done", async () => {
    await weeklyStats();
    const { p } = existingProject();
    lib.projects.link(p.id, "weekly-stats");
    expect(lib.projects.get(p.id).components[0]).toMatchObject({ integration: "", integrationDetail: "" });
  });

  it("a project recorded at another version must change version first", async () => {
    const c = await weeklyStats();
    const { p } = existingProject();
    lib.projects.link(p.id, "weekly-stats", "", "1.0.0");
    fs.appendFileSync(path.join(tmp, "shared", "weekly-stats", "weekly-stats", "weekly_stats", "__init__.py"), "\n# 1.1\n");
    await new Promise((r) => setTimeout(r, 30)); // the edit must be clearly before the test run
    expect((await lib.tests.run(c.id)).status).toBe("passed");
    lib.releases.create(c.id, { version: "1.1.0", changes: "Second." });
    expect(lib.integration.preview(p.id, "weekly-stats").problems.join(" ")).toMatch(/recorded at Weekly Stats 1\.0\.0/);
    expect(lib.integration.preview(p.id, "weekly-stats", "1.0.0").problems).toEqual([]);
  });
});
