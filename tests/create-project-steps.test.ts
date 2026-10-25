/**
 * Create project in five steps: the plan is edited and refined (with Undo),
 * components are matched and chosen, and every later step remembers exactly
 * what it was made from, so moving between steps redoes nothing and changed
 * inputs are never built from. Stand-in AI (tests/create/fake-generator.mjs),
 * which logs every request so they can be counted. Throwaway library only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLibrary, type Library, type ProjectDraft } from "../src/core";
import { unlockTree } from "../src/core/releases";
import { sandboxedPythonTestCommand } from "../src/core/sandbox";

const FAKE = path.resolve(import.meta.dirname, "create/fake-generator.mjs");
let tmp: string;
let lib: Library;
let log: string;
const env = { ...process.env };

/** How many AI requests have been made so far. */
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0);
const pc = () => lib.projectCreation;
const features = (d: ProjectDraft) => d.plan!.features.map((f) => ({ id: f.id, text: f.text, included: f.included }));

async function weeklyStats() {
  const src = path.join(tmp, "src", "weekly-stats");
  fs.mkdirSync(path.join(src, "weekly_stats"), { recursive: true });
  fs.mkdirSync(path.join(src, "tests"), { recursive: true });
  fs.writeFileSync(path.join(src, "weekly_stats", "__init__.py"), `"""Weekly numbers from exported rows."""\n\n\ndef summarize(rows):\n    """Total posts and likes from rows of an export."""\n    return {"posts": len(rows), "likes": sum(int(r.get("likes") or 0) for r in rows)}\n`);
  fs.writeFileSync(path.join(src, "tests", "test_weekly_stats.py"), `import unittest\nfrom weekly_stats import summarize\n\n\nclass T(unittest.TestCase):\n    def test_summarize(self):\n        self.assertEqual(summarize([{"likes": "2"}]), {"posts": 1, "likes": 2})\n`);
  const { component } = lib.components.createPackaged({ name: "Weekly Stats", category: "data", sources: [src], language: "Python", summary: "Totals posts and likes from exported Instagram rows.",
    capabilities: [{ name: "Weekly totals", description: "Posts and likes from exported rows" }], testCommand: sandboxedPythonTestCommand() });
  expect((await lib.tests.run(component.id)).status).toBe("passed");
  lib.releases.create(component.id, { version: "1.0.0", changes: "First release." });
}

const DETAILED = "A dashboard that reads my weekly Instagram export, works out the numbers and shows them on a page [use:weekly-stats]";

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cl-steps-")));
  log = path.join(tmp, "ai-calls.log");
  process.env.COMPONENT_LIBRARY_HOME = path.join(tmp, "home");
  process.env.COMPONENT_LIBRARY_CODE_DIR = path.join(tmp, "shared");
  process.env.COMPONENT_LIBRARY_GENERATOR = `echo call >> '${log}'; node '${FAKE}'`;
  lib = openLibrary(path.join(tmp, "home", "library.db"));
  lib.settings.update({ allowedRoots: [tmp], projectsRoot: path.join(tmp, "Projects") });
  lib.categories.create({ name: "Data" });
});

afterEach(() => {
  lib.db.close();
  const rel = path.join(tmp, "shared", "releases");
  if (fs.existsSync(rel)) unlockTree(rel);
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of ["COMPONENT_LIBRARY_HOME", "COMPONENT_LIBRARY_CODE_DIR", "COMPONENT_LIBRARY_GENERATOR"]) {
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
});

describe("1–2. describe and plan", () => {
  it("1. a detailed description becomes an editable plan, and nothing else happens yet", async () => {
    const d = await pc().start(DETAILED);
    expect(d.plan).toMatchObject({ name: "Weekly Dashboard", openEnded: false, technology: expect.stringMatching(/Python/) });
    expect(d.plan!.features.map((f) => [f.text, f.origin, f.included])).toEqual([
      ["Read your weekly Instagram export", "asked", true], ["Work out the weekly numbers", "asked", true],
      ["Show them on a dashboard page", "asked", true], ["Email a summary every Monday", "suggested", true]]);
    expect(d.analysis).toBeNull(); // components are matched only when the person continues
    expect(calls()).toBe(1);
    expect(fs.existsSync(path.join(tmp, "Projects"))).toBe(false);
  });

  it("2. a vague description gets a small starter project, clearly marked as a suggestion", async () => {
    const d = await pc().start("something with my notes maybe [vague]");
    expect(d.plan!.openEnded).toBe(true);
    expect(d.plan!.features.every((f) => f.origin === "suggested")).toBe(true); // nothing claimed as "asked"
  });

  it("3. name and description edits are saved, and don't make the components out of date", async () => {
    const d = await pc().start(DETAILED);
    await pc().analyze(d.id);
    const before = calls();
    pc().savePlan(d.id, { name: "My Instagram Week", description: "My numbers, weekly.", features: features(d) });
    const after = pc().get(d.id);
    expect(after.plan).toMatchObject({ name: "My Instagram Week", description: "My numbers, weekly." });
    expect(after.choice.folder).toBe("weekly-dashboard"); // the folder isn't renamed behind their back
    expect(pc().freshness(after).components).toBe("current");
    expect(calls()).toBe(before);
    expect(() => pc().savePlan(d.id, { name: " ", description: "", features: features(d) })).toThrow(/needs a name/);
  });

  it("4. features can be added, reworded, removed and left out; at least one must stay", async () => {
    const d = await pc().start(DETAILED);
    const [read, numbers, show, email] = features(d);
    pc().savePlan(d.id, { name: d.plan!.name, description: d.plan!.description,
      features: [{ ...read, text: "Read the CSV I download each Monday" }, numbers, { ...show, included: false }, { text: "Highlight the best post", included: true }] });
    const p = pc().get(d.id).plan!;
    expect(p.features.map((f) => [f.text, f.origin, f.included, f.edited])).toEqual([
      ["Read the CSV I download each Monday", "asked", true, true], ["Work out the weekly numbers", "asked", true, false],
      ["Show them on a dashboard page", "asked", false, false], ["Highlight the best post", "you", true, false]]);
    expect(p.features.some((f) => f.id === email.id)).toBe(false); // removed
    expect(() => pc().savePlan(d.id, { name: "x", description: "", features: p.features.map((f) => ({ ...f, included: false })) })).toThrow(/at least one feature/);
  });
});

describe("5–6. refining with AI, and Undo", () => {
  it("5. a refinement applies only the changes asked for, and says what changed", async () => {
    const d = await pc().start(DETAILED);
    await pc().refine(d.id, "Drop the email [remove:email] and call it [rename:Insta Week]");
    const r = pc().get(d.id);
    expect(r.plan!.name).toBe("Insta Week");
    expect(r.plan!.features.map((f) => f.text)).toEqual(["Read your weekly Instagram export", "Work out the weekly numbers", "Show them on a dashboard page"]);
    expect(r.refined!.changes).toEqual(["Name changed", "Removed “Email a summary every Monday”"]);
    expect(r.undo).toHaveLength(1);
    await expect(pc().refine(d.id, "Nothing really [noop]")).rejects.toThrow(/didn't change anything/);
    expect(pc().get(d.id).undo).toHaveLength(1); // a refinement that did nothing isn't an undo step
  });

  it("6. the person's own edits survive a refinement, and Undo brings back exactly what they had", async () => {
    const d = await pc().start(DETAILED);
    const [read, numbers, show, email] = features(d);
    pc().savePlan(d.id, { name: "My Week", description: "Mine.", features: [{ ...read, text: "Read the CSV I download" }, numbers, { ...show, included: false }, email, { text: "Highlight the best post", included: true }] });
    const mine = pc().get(d.id).plan!;
    await pc().refine(d.id, "Add a chart [add:Show a chart of likes per day]");
    const r = pc().get(d.id).plan!;
    expect(r.name).toBe("My Week");
    expect(r.description).toBe("Mine.");
    expect(r.features.slice(0, 5)).toEqual(mine.features); // every earlier feature exactly as the person left it
    expect(r.features[5]).toMatchObject({ text: "Show a chart of likes per day", origin: "suggested", included: true });
    pc().undo(d.id);
    expect(pc().get(d.id).plan).toEqual(mine);
    expect(() => pc().undo(d.id)).toThrow(/nothing to undo/);
  });

  it("Undo makes later steps current again when it restores their inputs, and out of date when it doesn't", async () => {
    await weeklyStats();
    const d = await pc().start(DETAILED);
    await pc().analyze(d.id);
    expect(pc().freshness(pc().get(d.id)).components).toBe("current");
    await pc().refine(d.id, "[remove:email]");
    expect(pc().freshness(pc().get(d.id)).components).toBe("outdated");
    pc().undo(d.id);
    expect(pc().freshness(pc().get(d.id)).components).toBe("current"); // the old match is valid again: no new request needed
    const before = calls();
    await pc().analyze(d.id);
    expect(calls()).toBe(before);
  });
  it("a new plan from a changed description can be undone too", async () => {
    const d = await pc().start(DETAILED);
    pc().savePlan(d.id, { name: "Mine", description: "", features: features(d) });
    const mine = pc().get(d.id).plan!;
    await pc().replan(d.id, "A tool that plans my meals for the week");
    expect(pc().get(d.id).plan!.name).toBe("Weekly Dashboard");
    expect(pc().get(d.id).undo.at(-1)!.instruction).toMatch(/new plan from your changed description/);
    pc().undo(d.id);
    expect(pc().get(d.id).plan).toEqual(mine);
  });
});

describe("7–8. components", () => {
  it("7. components are matched once, and again only when what the project must do changes", async () => {
    await weeklyStats();
    const d = await pc().start(DETAILED);
    await pc().analyze(d.id);
    const a = pc().get(d.id).analysis!;
    expect(a.needs.map((n) => [n.need, n.status, n.component])).toEqual([
      ["Read your weekly Instagram export", "build", null], ["Weekly numbers", "available", "weekly-stats"],
      ["Show them on a dashboard page", "build", null], ["Monday email", "setup", null]]);
    const n = calls();
    await pc().analyze(d.id);
    expect(calls()).toBe(n); // nothing changed: no request
    const cur = pc().get(d.id);
    pc().savePlan(d.id, { name: cur.plan!.name, description: cur.plan!.description, features: features(cur).map((f, i) => (i === 3 ? { ...f, included: false } : f)) });
    expect(pc().freshness(pc().get(d.id)).components).toBe("outdated");
    expect(pc().readyToBuild(pc().get(d.id)).join(" ")).toMatch(/plan changed after the components were matched/);
    await pc().analyze(d.id);
    expect(calls()).toBe(n + 1);
    expect(pc().get(d.id).analysis!.needs.some((x) => x.need === "Monday email")).toBe(false);
  });

  it("8. a component can be turned off (its need is built instead); optional needs can be left out; required ones can't", async () => {
    await weeklyStats();
    const d = await pc().start(DETAILED);
    await pc().analyze(d.id);
    const a = pc().get(d.id).analysis!;
    const numbers = a.needs.find((x) => x.component === "weekly-stats")!;
    const email = a.needs.find((x) => x.status === "setup")!;
    pc().choose(d.id, { useComponent: { "weekly-stats": false } });
    let dec = pc().decisions(pc().get(d.id));
    expect(dec.components).toEqual([]);
    expect(dec.needs.find((x) => x.id === numbers.id)).toMatchObject({ included: true, using: null, ifLeftOut: expect.stringMatching(/adds up likes/) }); // never silently dropped
    expect(() => pc().choose(d.id, { includeNeed: { [numbers.id]: false } })).toThrow(/needed for the project to work.*untick its feature in Plan/);
    pc().choose(d.id, { includeNeed: { [email.id]: false }, useComponent: { "weekly-stats": true } });
    dec = pc().decisions(pc().get(d.id));
    expect(dec.components.map((c) => c.slug)).toEqual(["weekly-stats"]);
    expect(dec.needs.find((x) => x.id === email.id)!.included).toBe(false);
  });
});

describe("9–11. moving between steps, resuming, and stale work", () => {
  async function tested() {
    await weeklyStats();
    const d = await pc().start(DETAILED);
    await pc().analyze(d.id);
    await pc().build(d.id);
    await pc().test(d.id);
    return pc().get(d.id);
  }

  it("9. going back and forward redoes nothing", async () => {
    const d = await tested();
    expect(d.tests!.status, d.tests!.stderr).toBe("passed");
    const n = calls();
    await pc().analyze(d.id);
    await pc().build(d.id);
    await pc().test(d.id);
    const again = pc().get(d.id);
    expect(calls()).toBe(n);
    expect(again.build!.attempt).toBe(1);
    expect(again.tests!.at).toBe(d.tests!.at);
    expect(pc().freshness(again)).toEqual({ components: "current", build: "current", tests: "current" });
  });

  it("10. a draft is read back from disk exactly, after a restart", async () => {
    const d = await tested();
    lib.db.close();
    lib = openLibrary(path.join(tmp, "home", "library.db"));
    const back = pc().get(d.id);
    expect(back).toEqual(d);
    expect(pc().list().map((x) => x.id)).toEqual([d.id]);
    expect(pc().ready(back).problems).toEqual([]);
  });

  it("11. changed inputs block building, testing and creating from old work", async () => {
    const d = await tested();
    pc().choose(d.id, { useComponent: { "weekly-stats": false } }); // a choice changed after the tests
    let cur = pc().get(d.id);
    expect(pc().freshness(cur)).toMatchObject({ build: "outdated", tests: "outdated" });
    await expect(pc().test(d.id)).rejects.toThrow(/Build it again first/);
    await expect(pc().create(d.id)).rejects.toThrow(/changed after this build/);
    pc().choose(d.id, { useComponent: { "weekly-stats": true } }); // changed back: the tested build counts again
    expect(pc().freshness(pc().get(d.id))).toMatchObject({ build: "current", tests: "current" });
    // Files changed after the tests ran don't count either.
    fs.appendFileSync(path.join(tmp, "home", "staging", d.id, "build", "weekly-dashboard", "app.py"), "\n# changed\n");
    cur = pc().get(d.id);
    expect(pc().freshness(cur).tests).toBe("outdated");
    await expect(pc().create(d.id)).rejects.toThrow(/files changed after the tests ran/);
    expect(fs.existsSync(path.join(tmp, "Projects"))).toBe(false);
  });

  it("drafts from the earlier version are recognised and can't be continued", async () => {
    const id = "pdr_0123456789abcdef0123";
    const dir = path.join(tmp, "home", "staging", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "draft.json"), JSON.stringify({ id, createdAt: "", updatedAt: "", prompt: "old", proposal: { name: "Old" },
      choice: { name: "Old", description: "", folder: "old", include: {} }, build: null, tests: null, project: null, busy: null, lastError: null }));
    expect(pc().get(id).legacy).toBe(true);
    expect(() => pc().savePlan(id, { name: "x", description: "", features: [] })).toThrow(/earlier version/);
    await expect(pc().build(id)).rejects.toThrow(/earlier version/);
  });

  it("edits wait while a step is running, so neither overwrites the other", async () => {
    const d = await pc().start(DETAILED);
    const f = path.join(tmp, "home", "staging", d.id, "draft.json");
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), busy: { step: "refine", since: new Date().toISOString() } }));
    expect(() => pc().savePlan(d.id, { name: "x", description: "", features: features(d) })).toThrow(/Wait for the current step/);
  });
});

describe("12–15. files, tests, fixing and creating", () => {
  it("12–13. the files can be read, and each test is reported by name, with the copy check", async () => {
    await weeklyStats();
    const d = await pc().start(DETAILED);
    await pc().analyze(d.id);
    await pc().build(d.id);
    expect(pc().files(pc().get(d.id)).map((f) => f.path).sort()).toEqual(["README.md", "app.py", "component_paths.py", "tests/test_app.py", "tests/test_components_match_release.py"]);
    await pc().test(d.id);
    const t = pc().testList(pc().get(d.id));
    expect(t.filter((x) => !x.copiesMatch).map((x) => [x.name, x.passed])).toEqual([["build", true]]);
    expect(t.some((x) => x.copiesMatch && x.passed)).toBe(true);
    expect(pc().connections(pc().get(d.id))["weekly-stats"].connected).toBe(true);
  });

  it("14. failed tests are fixed with AI, then run again", async () => {
    await weeklyStats();
    const d = await pc().start(`${DETAILED} [failing-tests]`);
    await pc().analyze(d.id);
    await pc().build(d.id);
    await pc().test(d.id);
    expect(pc().get(d.id).tests!.status).toBe("failed");
    expect(pc().testList(pc().get(d.id)).find((x) => x.name === "build")!.passed).toBe(false);
    await pc().build(d.id, "The tests failed: fix it.");
    expect(pc().get(d.id).tests).toBeNull(); // old results never count for new files
    expect(pc().get(d.id).build!.attempt).toBe(2);
    await pc().test(d.id);
    expect(pc().get(d.id).tests!.status).toBe("passed");
  });

  it("15. creating copies the tested files and records everything; a failure leaves nothing behind", async () => {
    await weeklyStats();
    const d = await pc().start(DETAILED);
    await pc().analyze(d.id);
    await pc().build(d.id);
    await pc().test(d.id);
    lib.db.exec(`CREATE TRIGGER fail_link BEFORE INSERT ON project_components BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`);
    await expect(pc().create(d.id)).rejects.toThrow(/simulated failure/);
    expect(fs.existsSync(path.join(tmp, "Projects", "weekly-dashboard"))).toBe(false);
    expect(lib.projects.list()).toEqual([]);
    lib.db.exec("DROP TRIGGER fail_link");
    await pc().create(d.id);
    const p = lib.projects.get(pc().get(d.id).project!.id);
    expect(p).toMatchObject({ name: "Weekly Dashboard", components: [expect.objectContaining({ slug: "weekly-stats", version: "1.0.0", integration: "connected" })] });
    expect(() => pc().savePlan(d.id, { name: "x", description: "", features: [] })).toThrow(/already been created/);
  });
});
