/**
 * Capture workflow, service layer: proposals, exclusions, secrets, origin
 * records, release readiness and creation, and running a release outside its
 * source project. Throwaway database and folders only.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLibrary, type Library } from "../src/core";
import { excludedReason, findSecrets } from "../src/core/packaging";
import { unlockTree } from "../src/core/releases";
import { TEST_COMMAND, treeHash, writeSourceProject } from "./capture/fixture";

let tmp: string;
let lib: Library;
let src: ReturnType<typeof writeSourceProject>;
let projectId: string;

const counts = () => Object.fromEntries(
  ["components", "component_sources", "component_releases", "project_components", "projects", "categories"]
    .map((t) => [t, (lib.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]),
);
const capture = (extra: Record<string, unknown> = {}) =>
  lib.components.createPackaged({
    name: "Email Tools", category: "text-processing", sources: [src.reusable], language: "Python", testCommand: TEST_COMMAND,
    summary: "Normalize, validate and dedupe email addresses.",
    capabilities: [{ name: "Email address normalization", description: "Lower-case, trim, Gmail dots and +tags" }, { name: "Email address validation" }, { name: "Email list deduplication" }],
    ...extra,
  }, { project: projectId });

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cl-capture-")));
  process.env.COMPONENT_LIBRARY_CODE_DIR = path.join(tmp, "shared");
  lib = openLibrary(path.join(tmp, "library.db"));
  lib.settings.update({ allowedRoots: [tmp] });
  lib.categories.create({ name: "Text Processing" });
  src = writeSourceProject(path.join(tmp, "newsletter-app"));
  projectId = lib.projects.register({ path: src.root, name: "Newsletter app" }).id;
});

afterEach(() => {
  lib.db.close();
  const rel = path.join(tmp, "shared", "releases");
  if (fs.existsSync(rel)) unlockTree(rel);
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.COMPONENT_LIBRARY_CODE_DIR;
});

describe("capture proposals", () => {
  it("lists exactly what would be copied and left out, and changes nothing", () => {
    const before = { tree: treeHash(src.root), counts: counts() };
    const p = lib.capture.propose({ name: "Email Tools", category: "text-processing", sources: [src.reusable], capabilities: ["Email address normalization"] });
    expect(p.changed).toBe(false);
    expect(p.files.included.sort()).toEqual(["email_tools/README.md", "email_tools/__init__.py", "email_tools/normalize.py", "email_tools/tests/test_normalize.py"]);
    expect(p.files.excluded.map((e) => e.path).sort()).toEqual(["email_tools/.env.local", "email_tools/__pycache__", "email_tools/subscribers.db"]);
    expect(p.files.excluded.find((e) => e.path.endsWith("subscribers.db"))!.reason).toMatch(/personal data/);
    expect(p.files.secrets).toEqual([]);
    expect(p.tests.files).toEqual(["email_tools/tests/test_normalize.py"]);
    expect(p.dependencies.imports).toEqual(expect.arrayContaining(["re", "unicodedata"]));
    expect(p.dependencies.imports).not.toContain("email_tools");
    expect(p.reachesOutside).toEqual([]);
    expect(p.sourceProject).toMatchObject({ registered: true, name: "Newsletter app" });
    expect(p.category.match?.slug).toBe("text-processing");
    expect(p.duplicates.verdict).toBe("none");
    expect(p.blockers).toEqual([]);
    expect(p.destination.firstRelease).toBe(path.join(tmp, "shared", "releases", "email-tools", "1.0.0"));
    // Nothing written anywhere.
    expect(treeHash(src.root)).toBe(before.tree);
    expect(counts()).toEqual(before.counts);
    expect(fs.existsSync(path.join(tmp, "shared", "email-tools"))).toBe(false);
  });

  it("flags a trivial helper as too small", () => {
    const p = lib.capture.propose({ name: "Slug", sources: [src.trivial] });
    expect(p.files.codeLines).toBeLessThan(30);
    expect(p.signals.join(" ")).toMatch(/^Small: 2 lines/);
  });

  it("flags code that reaches into its application, and the configuration it reads", () => {
    const p = lib.capture.propose({ name: "Sign up", sources: [src.tied] });
    expect(p.reachesOutside.map((r) => r.import)).toEqual(["from app.db import save", "from app import settings"]);
    expect(p.signals.join(" ")).toMatch(/Tied to its application: 2 import/);
    const settings = lib.capture.propose({ name: "Settings", sources: [path.join(src.root, "app", "settings.py")] });
    expect(settings.configuration).toEqual(["MAILER_API_KEY"]);
  });

  it("suggests registering the source folder when it is not a registered project", () => {
    lib.projects.unregister(projectId);
    const p = lib.capture.propose({ name: "Email Tools", sources: [src.reusable] });
    expect(p.sourceProject).toMatchObject({ registered: false, suggestedPath: src.root });
  });

  it("finds a duplicate even when the name differs, and blocks an exact one", () => {
    capture();
    const renamed = lib.capture.propose({ name: "Address Cleaner", sources: [src.reusable], summary: "normalize and validate email addresses", capabilities: ["Email address normalization"] });
    expect(renamed.duplicates.verdict).not.toBe("none");
    expect(renamed.duplicates.similar.map((m) => m.component.slug)).toContain("email-tools");
    const same = lib.capture.propose({ name: "Email Tools", sources: [src.reusable] });
    expect(same.duplicates.verdict).toBe("exact");
    expect(same.blockers.join(" ")).toMatch(/Already in the library: email-tools/);
    expect(same.blockers.join(" ")).toMatch(/slug "email-tools" is already used/);
  });

  it("refuses an unknown category instead of inventing one", () => {
    const p = lib.capture.propose({ name: "Email Tools", category: "Mail stuff", sources: [src.reusable] });
    expect(p.blockers.join(" ")).toMatch(/no category "Mail stuff"/);
  });
});

describe("secrets and sensitive files", () => {
  it("never copies keys, credentials, databases or logs, judged by name", () => {
    for (const n of [".env", ".env.production", "prod.env", "id_rsa", "id_ed25519.pub", "server.pem", "cert.p12", ".npmrc", ".netrc",
      "credentials.json", "secrets.yaml", "discord_webhook.txt", "api_key.txt", "service-account-prod.json", "app.db", "data.sqlite3", "run.log", ".git-credentials"])
      expect(excludedReason(n), n).not.toBeNull();
    for (const n of ["token.ts", "tokens.py", "secret_sharing.py", "normalize.py", "README.md", "tools.json", "package.json"])
      expect(excludedReason(n), n).toBeNull();
  });

  it("blocks credentials written into code, and copies nothing", () => {
    fs.writeFileSync(path.join(src.reusable, "client.py"), 'API_KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123"\n');
    const p = lib.capture.propose({ name: "Email Tools", sources: [src.reusable] });
    expect(p.files.secrets).toEqual([{ file: "email_tools/client.py", line: 1, label: "Anthropic API key" }]);
    expect(p.blockers.join(" ")).toMatch(/look like credentials/);
    const before = counts();
    expect(() => capture()).toThrow(/Nothing was copied: 1 line\(s\) look like credentials: .*client\.py:1/);
    expect(counts()).toEqual(before);
    expect(fs.existsSync(path.join(tmp, "shared", "email-tools"))).toBe(false);
  });

  it("does not flag ordinary code that reads keys from configuration", () => {
    const f = path.join(tmp, "ok.py");
    fs.writeFileSync(f, 'import os\napi_key = os.environ["API_KEY"]\npassword = getpass()\ntoken = "${TOKEN}"\nSECRET = ""\n');
    expect(findSecrets([f])).toEqual([]);
    for (const [label, line] of [
      ["private key", "-----BEGIN RSA PRIVATE KEY-----"], ["AWS access key", "AKIAIOSFODNN7EXAMPLE"],
      ["GitHub token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
      ["webhook URL (works like a password)", "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGH"],
      ["webhook URL (works like a password)", "url = 'https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX'"], ["password or key written into the code", 'password = "correct-horse-battery"'],
    ]) {
      fs.writeFileSync(f, line + "\n");
      expect(findSecrets([f])[0]?.label).toBe(label);
    }
  });
});

describe("capturing", () => {
  it("copies the reusable folder, records where it came from, and leaves the project untouched", () => {
    const before = treeHash(src.root);
    const { component, packaged } = capture();
    expect(treeHash(src.root)).toBe(before);
    expect(packaged.paths).toEqual([path.join(tmp, "shared", "email-tools", "email_tools")]);
    const copied = fs.readdirSync(packaged.paths[0]).sort();
    expect(copied).toEqual(["README.md", "__init__.py", "normalize.py", "tests"]);
    expect(component.origin).toEqual({ project: { id: projectId, name: "Newsletter app", path: src.root }, paths: [src.reusable] });
    // Origin, not use: no link, no version.
    const p = lib.projects.get(projectId);
    expect(p.components).toEqual([]);
    expect(p.componentCount).toBe(0);
    expect(p.originOf.map((c) => c.slug)).toEqual(["email-tools"]);
    expect(component.projects).toEqual([]);
  });

  it("records the original files when a separated copy is captured", () => {
    const staged = path.join(tmp, "staging", "email-tools", "email_tools");
    fs.cpSync(src.reusable, staged, { recursive: true });
    const { component } = lib.components.createPackaged(
      { name: "Email Tools", category: "text-processing", sources: [staged] },
      { project: projectId, paths: [path.join(src.reusable, "normalize.py"), path.join(src.reusable, "__init__.py")] },
    );
    expect(component.origin!.paths).toEqual([path.join(src.reusable, "normalize.py"), path.join(src.reusable, "__init__.py")]);
  });

  it("refuses original paths outside the named project before copying anything", () => {
    const elsewhere = path.join(tmp, "elsewhere");
    fs.mkdirSync(elsewhere);
    expect(() => lib.components.createPackaged({ name: "Email Tools", category: "text-processing", sources: [src.reusable] }, { project: projectId, paths: [elsewhere] }))
      .toThrow(/not inside "Newsletter app"/);
    expect(fs.existsSync(path.join(tmp, "shared", "email-tools"))).toBe(false);
  });

  it("keeps the origin record honest when the project is unregistered", () => {
    const { component } = capture();
    lib.projects.unregister(projectId);
    expect(lib.components.get(component.id).origin).toEqual({ project: null, paths: [src.reusable] });
  });
});

describe("releases from a capture", () => {
  it("only releases files whose tests passed as they are now", async () => {
    const { component } = capture();
    expect(lib.releases.readiness(component.id).problems.join(" ")).toMatch(/never been run/);
    expect(() => lib.releases.create(component.id, { version: "1.0.0", changes: "First release." })).toThrow(/never been run/);

    fs.chmodSync(path.join(tmp, "shared", "email-tools", "email_tools", "normalize.py"), 0o644);
    fs.appendFileSync(path.join(tmp, "shared", "email-tools", "email_tools", "normalize.py"), "\nraise SystemExit(3)\n");
    expect((await lib.tests.run(component.id)).status).toBe("failed");
    expect(lib.releases.readiness(component.id).problems.join(" ")).toMatch(/latest test run failed/);

    const good = fs.readFileSync(path.join(src.reusable, "normalize.py"));
    fs.writeFileSync(path.join(tmp, "shared", "email-tools", "email_tools", "normalize.py"), good);
    const run = await lib.tests.run(component.id);
    expect(run.status, run.stderr).toBe("passed");
    expect(lib.releases.readiness(component.id)).toMatchObject({ ready: true, problems: [], from: path.join(tmp, "shared", "email-tools") });

    // Edited after the passing run: not released until tested again.
    await new Promise((r) => setTimeout(r, 20));
    fs.appendFileSync(path.join(tmp, "shared", "email-tools", "email_tools", "README.md"), "\nEdited.\n");
    expect(lib.releases.readiness(component.id).problems.join(" ")).toMatch(/changed after the last test run \(email_tools\/README\.md\)/);
  });

  it("creates a frozen, checksummed, read-only release and never overwrites it", async () => {
    const { component } = capture();
    expect((await lib.tests.run(component.id)).status).toBe("passed");
    const { release, files } = lib.releases.create(component.id, { version: "1.0.0", changes: "First release: normalize, validate, dedupe." });
    expect(files).toBe(4);
    expect(release.sourcePath).toBe(path.join(tmp, "shared", "releases", "email-tools", "1.0.0"));
    expect(lib.releases.verify(component.id, "1.0.0").state).toBe("intact");
    expect(lib.components.get(component.id).version).toBe("1.0.0");
    const manifest = JSON.parse(fs.readFileSync(path.join(release.sourcePath, "RELEASE.json"), "utf8"));
    expect(manifest).toMatchObject({ component: "email-tools", version: "1.0.0", checksum: release.checksum });
    expect(() => fs.writeFileSync(path.join(release.sourcePath, "email_tools", "normalize.py"), "x")).toThrow();
    expect(() => lib.releases.create(component.id, { version: "1.0.0", changes: "Again." })).toThrow(/newer than the latest release, 1\.0\.0/);
    // The origin project still does not "use" it.
    expect(lib.projects.get(projectId).components).toEqual([]);
  });

  it("runs from its release folder in another project, with only the standard library", async () => {
    const { component } = capture();
    await lib.tests.run(component.id);
    const { release } = lib.releases.create(component.id, { version: "1.0.0", changes: "First release." });
    const consumer = path.join(tmp, "consumer");
    fs.mkdirSync(consumer);
    fs.writeFileSync(path.join(consumer, "use_it.py"), [
      "import json, sys",
      `sys.path.insert(0, ${JSON.stringify(release.sourcePath)})`,
      "from email_tools import dedupe",
      "print(json.dumps(dedupe(['Ana@Example.com', 'ana@example.com ', 'nope', 'J.S+x@gmail.com'])))",
    ].join("\n"));
    // -I: isolated mode, so nothing from the source project or the environment is importable.
    const out = execFileSync("python3", ["-I", "use_it.py"], { cwd: consumer, encoding: "utf8" });
    expect(JSON.parse(out)).toEqual([["ana@example.com", "js@gmail.com"], ["nope"]]);
    // The release's own tests pass where it sits.
    execFileSync("python3", ["-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"], { cwd: path.join(release.sourcePath, "email_tools"), stdio: "pipe" });
    expect(lib.releases.verify(component.id, "1.0.0").state).toBe("intact"); // running it changed nothing
  });
});
