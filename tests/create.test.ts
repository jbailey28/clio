/**
 * Creating a component from a description, service layer, with a stand-in for
 * the AI (tests/create/fake-generator.mjs). Tests really run in the macOS
 * sandbox. Throwaway library, data folder and code folder only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLibrary, type Library } from "../src/core";
import { unlockTree } from "../src/core/releases";

const FAKE = `node ${path.resolve(import.meta.dirname, "create/fake-generator.mjs")}`;
let tmp: string;
let lib: Library;
const env = { ...process.env };

const counts = () => Object.fromEntries(["components", "component_releases", "categories", "test_runs"]
  .map((t) => [t, (lib.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]));
const codeDir = () => path.join(tmp, "shared");
const libraryFolders = () => (fs.existsSync(codeDir()) ? fs.readdirSync(codeDir()).sort() : []);
/** Describe, accept the proposal, generate and test: the usual path to a draft that is ready to register. */
async function readyDraft(prompt: string) {
  const d = await lib.creation.start(prompt);
  await lib.creation.generate(d.id);
  await lib.creation.runTests(d.id);
  return lib.creation.get(d.id);
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cl-create-")));
  process.env.COMPONENT_LIBRARY_HOME = path.join(tmp, "home");
  process.env.COMPONENT_LIBRARY_CODE_DIR = codeDir();
  process.env.COMPONENT_LIBRARY_GENERATOR = FAKE;
  lib = openLibrary(path.join(tmp, "home", "library.db"));
  lib.settings.update({ allowedRoots: [tmp] });
  lib.categories.create({ name: "Data Handling", description: "Import, clean, and validate data." });
});

afterEach(() => {
  lib.db.close();
  const rel = path.join(codeDir(), "releases");
  if (fs.existsSync(rel)) unlockTree(rel);
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of ["COMPONENT_LIBRARY_HOME", "COMPONENT_LIBRARY_CODE_DIR", "COMPONENT_LIBRARY_GENERATOR", "CL_MARKER"]) {
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
});

describe("categories, enforced by the service layer", () => {
  it("a category can exist on its own, with no components, and be deleted while empty", () => {
    const c = lib.categories.create({ name: "Utilities" });
    expect(lib.categories.get(c.slug).componentCount).toBe(0);
    expect(lib.categories.delete(c.slug)).toEqual({ deleted: c.id });
  });

  it("a component can't be registered without a category, or with one that doesn't exist", () => {
    const src = path.join(tmp, "code");
    fs.mkdirSync(src);
    expect(() => lib.components.create({ name: "No Category", sources: [src] } as any)).toThrow(/Category is required/);
    expect(() => lib.components.create({ name: "Bad Category", category: "nope", sources: [src] })).toThrow(/Category "nope" was not found|not found/i);
    expect(counts().components).toBe(0);
  });

  it("a category with components can't be deleted, so no component is ever left without one", async () => {
    await lib.creation.register((await readyDraft("Clean a list of email addresses [cat:data-handling]")).id);
    expect(() => lib.categories.delete("data-handling")).toThrow(/still has 1 component/);
    expect(() => lib.db.prepare("DELETE FROM categories WHERE slug = 'data-handling'").run()).toThrow(/FOREIGN KEY/);
  });
});

describe("creating from a description", () => {
  it("existing category: describe → proposal → generate → test → register and release 1.0.0", async () => {
    let d = await lib.creation.start("Clean a list of email addresses [cat:data-handling]");
    expect(lib.creation.stage(d)).toBe("proposed");
    expect(d.choice).toMatchObject({ name: "Email Cleaner", category: "data-handling" });
    expect(counts()).toMatchObject({ components: 0, test_runs: 0 }); // nothing in the library yet

    await lib.creation.generate(d.id);
    d = lib.creation.get(d.id);
    expect(lib.creation.stage(d)).toBe("generated");
    expect(d.generation!.files.map((f) => f.path)).toEqual(["email_cleaner/__init__.py", "README.md", "tests/test_email_cleaner.py"]);
    expect(d.generation!.checks).toMatchObject({ ok: true, problems: [], imports: ["re", "unittest"] });
    expect(libraryFolders()).toEqual([]); // still only in staging

    await lib.creation.runTests(d.id);
    d = lib.creation.get(d.id);
    expect(d.tests!.status, d.tests!.stderr).toBe("passed");
    expect(lib.creation.stage(d)).toBe("tested");
    expect(counts().test_runs).toBe(0); // the staged run is not a library record

    await lib.creation.register(d.id);
    d = lib.creation.get(d.id);
    expect(d.component).toEqual({ slug: "email-cleaner", version: "1.0.0" });
    const c = lib.components.get("email-cleaner");
    expect(c).toMatchObject({ categorySlug: "data-handling", version: "1.0.0", lastTestStatus: "passed", language: "Python" });
    expect(c.testCommand).toMatch(/sandbox-exec/);
    expect(c.documentation).toMatch(/releases\/email-cleaner\/1\.0\.0\/email-cleaner/);
    expect(lib.releases.verify(c.id, "1.0.0").state).toBe("intact");
    expect(lib.discovery.find("dedupe email addresses").results[0]?.component.slug).toBe("email-cleaner");
    expect(lib.creation.list()).toEqual([]); // finished drafts leave the list
  });

  it("asks follow-up questions only when needed, then proposes", async () => {
    const d = await lib.creation.start("Clean emails somehow [questions] [cat:data-handling]");
    expect(lib.creation.stage(d)).toBe("asking");
    expect(() => lib.creation.readyToGenerate(d)).not.toThrow();
    await expect(lib.creation.answer(d.id, [""])).rejects.toThrow(/Answer each question/);
    await lib.creation.answer(d.id, ["Drop them"]);
    const after = lib.creation.get(d.id);
    expect(lib.creation.stage(after)).toBe("proposed");
    expect(after.answers).toEqual([{ question: "Should addresses without an @ be dropped or kept?", answer: "Drop them" }]);
  });

  it("a new category can be created during creation, and only when asked", async () => {
    let d = await lib.creation.start("Clean a list of email addresses [new-category]");
    expect(d.choice.category).toBe(""); // suggested, not created
    expect(d.proposal!.category.newName).toBe("Text Tools");
    expect(lib.categories.list().map((c) => c.name)).toEqual(["Data Handling"]);
    expect(lib.creation.readyToGenerate(d)).toContain("Choose a category first. Every component belongs to exactly one category.");
    await expect(lib.creation.generate(d.id)).rejects.toThrow(/Choose a category first/);

    const cat = lib.categories.create({ name: "Text Tools" }); // what the "Create category and choose it" button does
    lib.creation.edit(d.id, { category: cat.slug });
    await lib.creation.generate(d.id);
    await lib.creation.runTests(d.id);
    await lib.creation.register(d.id);
    expect(lib.components.get("email-cleaner").categorySlug).toBe("text-tools");
  });

  it("refuses a category that doesn't exist, at every step", async () => {
    const d = await lib.creation.start("Clean a list of email addresses [cat:data-handling]");
    expect(() => lib.creation.edit(d.id, { category: "imaginary" })).toThrow(/not found/i);
    await lib.creation.generate(d.id);
    await lib.creation.runTests(d.id);
    // The category disappears after testing: registering is refused, nothing is added.
    const created = lib.categories.create({ name: "Temporary" });
    lib.creation.edit(d.id, { category: created.slug });
    lib.categories.delete(created.slug);
    await expect(lib.creation.register(d.id)).rejects.toThrow(/no longer exists/);
    expect(counts().components).toBe(0);
    expect(libraryFolders()).toEqual([]);
  });

  it("detects an existing component and recommends reusing it; the same name is blocked", async () => {
    await lib.creation.register((await readyDraft("Clean a list of email addresses [cat:data-handling]")).id);
    const again = await lib.creation.start("I need to dedupe and clean email addresses [cat:data-handling]");
    const { components, sameName } = lib.creation.similar(again);
    expect(components).toContainEqual(expect.objectContaining({ slug: "email-cleaner", verdict: "same", name: "Email Cleaner" }));
    expect(sameName).toEqual(["Email Cleaner"]);
    expect(lib.creation.readyToGenerate(again).join(" ")).toMatch(/"Email Cleaner" is already in the library/);
    await expect(lib.creation.generate(again.id)).rejects.toThrow(/already in the library/);
  });

  it("a component the search shortlists only by shared words is not presented as already doing the job", async () => {
    const src = path.join(tmp, "wa");
    fs.mkdirSync(src);
    lib.categories.create({ name: "Website Research" });
    lib.components.create({ name: "Website Analysis", category: "website-research", sources: [src],
      summary: "Reads a website and says what it runs: ecommerce platform, support chat, email and SMS tools.",
      capabilities: [{ name: "Email and SMS detection", description: "email marketing tools on a page" }, { name: "Unknown is never not found", description: "an unreadable page returns unknown with a reason", kind: "check" }] });
    const prompt = "Take a block of text and pull out every email address and phone number in it [cat:data-handling] [name:Contact Extractor]";
    expect(lib.discovery.find(prompt).results[0]).toMatchObject({ component: { slug: "website-analysis" } }); // the word search alone says it matches
    const d = await lib.creation.start(prompt);
    expect(lib.creation.similar(d).components).toEqual([expect.objectContaining({ slug: "website-analysis", verdict: "different" })]);
    expect(lib.creation.readyToGenerate(d)).toEqual([]); // nothing stops building it
  });

  it("declining the proposal (discard) leaves the library unchanged and removes only the draft", async () => {
    const before = counts();
    const d = await lib.creation.start("Clean a list of email addresses [cat:data-handling]");
    const dir = path.join(tmp, "home", "staging", d.id);
    expect(fs.existsSync(dir)).toBe(true);
    lib.creation.discard(d.id);
    expect(fs.existsSync(dir)).toBe(false);
    expect(counts()).toEqual(before);
    expect(libraryFolders()).toEqual([]);
    expect(() => lib.creation.get(d.id)).toThrow(/not found/i);
  });

  it("declining code execution: generated code never runs, and it can't be registered", async () => {
    const marker = path.join(tmp, "ran.txt");
    process.env.CL_MARKER = marker;
    const d = await lib.creation.start("Clean a list of email addresses [marker] [cat:data-handling]");
    await lib.creation.generate(d.id);
    expect(fs.existsSync(marker)).toBe(false); // generating and checking never imports the code
    await expect(lib.creation.register(d.id)).rejects.toThrow(/tests have not passed/);
    expect(fs.existsSync(marker)).toBe(false);
    expect(counts()).toMatchObject({ components: 0, test_runs: 0 });
  });

  it("failed generation is reported, keeps the proposal, and can be retried", async () => {
    const failing = await lib.creation.start("Clean a list of email addresses [fail-propose]");
    expect(failing.proposal).toBeNull();
    expect(failing.lastError).toMatchObject({ step: "proposal" });
    expect(failing.lastError!.message).toMatch(/exit code 1.*model overloaded/);

    const d = await lib.creation.start("Clean a list of email addresses [fail-generate] [cat:data-handling]");
    await expect(lib.creation.generate(d.id)).rejects.toThrow(/not JSON/);
    const after = lib.creation.get(d.id);
    expect(after.generation).toBeNull();
    expect(after.proposal).not.toBeNull();
    expect(after.lastError!.step).toBe("generate");
    expect(after.busy).toBeNull();
  });

  it("files outside the component are refused before anything is written", async () => {
    const d = await lib.creation.start("Clean a list of email addresses [bad-path] [cat:data-handling]");
    await expect(lib.creation.generate(d.id)).rejects.toThrow(/"\.\.\/escape\.py": only plain relative paths/);
    expect(fs.existsSync(path.join(tmp, "home", "staging", d.id, "build"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "home", "staging", d.id, "escape.py"))).toBe(false);
  });

  it("failed tests are shown, block registration, and Fix with AI can repair them", async () => {
    const d = await lib.creation.start("Clean a list of email addresses [failing-tests] [cat:data-handling]");
    await lib.creation.generate(d.id);
    await lib.creation.runTests(d.id);
    let after = lib.creation.get(d.id);
    expect(after.tests!.status).toBe("failed");
    expect(after.tests!.stderr).toMatch(/FAILED \(failures=1\)/);
    expect(lib.creation.stage(after)).toBe("generated");
    await expect(lib.creation.register(d.id)).rejects.toThrow(/tests have not passed/);

    await lib.creation.generate(d.id, `The tests failed:\n${after.tests!.stderr}`);
    after = lib.creation.get(d.id);
    expect(after.generation!.attempt).toBe(2);
    expect(after.tests).toBeNull(); // old results never carry over to new files
    await lib.creation.runTests(d.id);
    expect(lib.creation.get(d.id).tests!.status).toBe("passed");
  });

  it("changed files after a passing run must be tested again", async () => {
    const d = await readyDraft("Clean a list of email addresses [cat:data-handling]");
    fs.appendFileSync(path.join(tmp, "home", "staging", d.id, "build", "email-cleaner", "email_cleaner", "__init__.py"), "\n# edited\n");
    expect(lib.creation.stage(lib.creation.get(d.id))).toBe("generated");
    await expect(lib.creation.register(d.id)).rejects.toThrow(/tests have not passed/);
  });

  it("refreshing or leaving midway: the draft resumes from disk, and a step can't run twice at once", async () => {
    const d = await lib.creation.start("Clean a list of email addresses [cat:data-handling]");
    await lib.creation.generate(d.id);
    lib.db.close();
    lib = openLibrary(path.join(tmp, "home", "library.db")); // a new server process, same files
    const resumed = lib.creation.get(d.id);
    expect(lib.creation.stage(resumed)).toBe("generated");
    expect(lib.creation.list().map((x) => x.id)).toEqual([d.id]);

    const file = path.join(tmp, "home", "staging", d.id, "draft.json");
    const busy = { ...resumed, busy: { step: "generate", since: new Date().toISOString() } };
    fs.writeFileSync(file, JSON.stringify(busy));
    await expect(lib.creation.runTests(d.id)).rejects.toThrow(/still busy with "generate"/);
    fs.writeFileSync(file, JSON.stringify({ ...busy, busy: { step: "generate", since: new Date(Date.now() - 3600_000).toISOString() } }));
    await lib.creation.runTests(d.id); // a step left behind by a crash expires
    expect(lib.creation.get(d.id).tests!.status).toBe("passed");
  });

  it("progress: each step reports what it is really doing, and only while it runs", async () => {
    const d = await lib.creation.start("Clean a list of email addresses [slow] [cat:data-handling]");
    const seen = new Set<string>();
    const watching = setInterval(() => { const b = lib.creation.active(lib.creation.get(d.id)); if (b?.detail) seen.add(`${b.step}: ${b.detail}`); }, 50);
    await lib.creation.generate(d.id);
    await lib.creation.runTests(d.id);
    await lib.creation.register(d.id);
    clearInterval(watching);
    // The 3-second AI call is always caught by the 50 ms watcher; quicker steps may finish between looks.
    expect(seen.has("generate: Generating code…")).toBe(true);
    for (const msg of seen) expect(msg).toMatch(/^(proposal|generate|tests|register): [A-Z].*…$/);
    expect(lib.creation.active(lib.creation.get(d.id))).toBeNull(); // finished: nothing claims to be running
  });

  it("a step left behind by a crash is not reported as running", async () => {
    const d = await lib.creation.start("Clean a list of email addresses [cat:data-handling]");
    const file = path.join(tmp, "home", "staging", d.id, "draft.json");
    const draft = lib.creation.get(d.id);
    fs.writeFileSync(file, JSON.stringify({ ...draft, busy: { step: "generate", since: new Date(Date.now() - 3600_000).toISOString(), detail: "Generating code…" } }));
    expect(lib.creation.active(lib.creation.get(d.id))).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ ...draft, busy: { step: "generate", since: new Date().toISOString(), detail: "Generating code…" } }));
    expect(lib.creation.active(lib.creation.get(d.id))).toMatchObject({ step: "generate", detail: "Generating code…" });
  });

  it("secrets never get into a component: the code is not run and can't be registered", async () => {
    const d = await lib.creation.start("Clean a list of email addresses [secret] [cat:data-handling]");
    await lib.creation.generate(d.id);
    const after = lib.creation.get(d.id);
    expect(after.generation!.checks.ok).toBe(false);
    expect(after.generation!.checks.secrets).toEqual([{ file: "email_cleaner/__init__.py", line: 17, label: "Anthropic API key" }]);
    await expect(lib.creation.runTests(d.id)).rejects.toThrow(/safety checks found problems/);
    await expect(lib.creation.register(d.id)).rejects.toThrow(/tests have not passed/);
    expect(libraryFolders()).toEqual([]);
  });

  it("third-party packages are never installed: the proposal says so, and an import is refused", async () => {
    const needs = await lib.creation.start("Fetch pages with requests [needs-package] [cat:data-handling]");
    expect(lib.creation.readyToGenerate(needs).join(" ")).toMatch(/needs requests.*never installed automatically/i);
    await expect(lib.creation.generate(needs.id)).rejects.toThrow(/never installed automatically/);

    const d = await lib.creation.start("Clean a list of email addresses [third-party] [cat:data-handling] [name:Email Tidy]");
    await lib.creation.generate(d.id);
    const checks = lib.creation.get(d.id).generation!.checks;
    expect(checks.ok).toBe(false);
    expect(checks.problems.join(" ")).toMatch(/imports requests, which is not part of Python's standard library/);
  });

  it("the sandbox: generated tests can't reach the network, write outside, or read your files", async () => {
    const d = await lib.creation.start("Clean a list of email addresses [cat:data-handling]");
    await lib.creation.generate(d.id);
    const dir = path.join(tmp, "home", "staging", d.id, "build", "email-cleaner");
    const outside = path.join(tmp, "escaped.txt");
    fs.writeFileSync(path.join(dir, "tests", "test_escape.py"), `import os, unittest, urllib.request
class Escape(unittest.TestCase):
    def test_network(self):
        with self.assertRaises(OSError): urllib.request.urlopen("https://example.com", timeout=5)
    def test_write_outside(self):
        with self.assertRaises(PermissionError): open(${JSON.stringify(outside)}, "w")
    def test_write_own_folder(self):
        with self.assertRaises(PermissionError): open("x.txt", "w")
    def test_read_home(self):
        with self.assertRaises(PermissionError): open(${JSON.stringify(path.resolve(import.meta.dirname, "../package.json"))})
`);
    await lib.creation.runTests(d.id);
    const t = lib.creation.get(d.id).tests!;
    expect(t.status, t.stderr).toBe("passed");
    expect(t.stderr).toMatch(/Ran 6 tests/);
    expect(fs.existsSync(outside)).toBe(false);
  });
});
