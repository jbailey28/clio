/**
 * The capture workflow end to end, the way Claude Code drives it: a real MCP
 * client against the real server process, a throwaway library, a source
 * project and a separate consumer project. The client plays the user's part
 * in every approval prompt, including saying no.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { openLibrary } from "../src/core";
import { unlockTree } from "../src/core/releases";
import { TEST_COMMAND, treeHash, writeSourceProject } from "./capture/fixture";

const BIN = path.resolve(import.meta.dirname, "../bin/component-library-mcp");
let tmp: string;
let codeDir: string;
let src: ReturnType<typeof writeSourceProject>;
let consumer: string;
let sourceHash: string;
let client: Client;
let answer: "approve" | "decline" = "approve";
let prompts: string[] = [];

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const text = res.content[0].text;
  return { isError: !!res.isError, text, data: res.isError ? null : JSON.parse(text) };
};
/** Library state that a declined step must leave alone. */
const snapshot = () => {
  const lib = openLibrary(path.join(tmp, "library.db"));
  const rows = Object.fromEntries(["components", "component_releases", "project_components", "projects", "test_runs"]
    .map((t) => [t, (lib.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]));
  lib.db.close();
  return { rows, code: fs.existsSync(codeDir) ? fs.readdirSync(codeDir).sort() : [], source: treeHash(src.root) };
};

const CAPTURE = {
  name: "Email Tools",
  category: "text-processing",
  package_into_library: true,
  language: "Python",
  summary: "Normalize, validate and dedupe email addresses. Standard library only.",
  documentation: "Add the release folder to sys.path, then: from email_tools import normalize, is_valid, dedupe, split_address.",
  capabilities: [
    { name: "Email address normalization", description: "Lower-case the domain, trim, apply Gmail dot and +tag rules" },
    { name: "Email address validation", description: "Well-formed check; does not contact the mailbox" },
    { name: "Email list deduplication", description: "Normalized, first occurrence kept, invalid inputs returned separately" },
  ],
  inputs: [{ name: "addresses", type: "list[str]" }],
  outputs: [{ name: "kept, rejected", type: "tuple[list[str], list[str]]" }],
  dependencies: [{ type: "system", name: "python3", version: ">=3.9" }],
  test_command: TEST_COMMAND,
};

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cl-mcp-capture-")));
  codeDir = path.join(tmp, "shared");
  src = writeSourceProject(path.join(tmp, "newsletter-app"));
  consumer = path.join(tmp, "invoice-app");
  fs.mkdirSync(consumer);
  const lib = openLibrary(path.join(tmp, "library.db"));
  lib.settings.update({ allowedRoots: [tmp] });
  lib.categories.create({ name: "Text Processing", description: "Cleaning and transforming text" });
  lib.projects.register({ path: src.root, name: "Newsletter app" });
  lib.db.close();
  sourceHash = treeHash(src.root);

  client = new Client({ name: "test", version: "1" }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    prompts.push(String(req.params.message));
    return answer === "decline" ? { action: "decline" } : { action: "accept", content: { approve: true } };
  });
  await client.connect(new StdioClientTransport({
    command: BIN,
    cwd: src.root, // Claude Code started in the source project
    env: { ...(process.env as Record<string, string>), COMPONENT_LIBRARY_HOME: tmp, COMPONENT_LIBRARY_CODE_DIR: codeDir },
    stderr: "ignore",
  }));
});

afterAll(async () => {
  await client?.close();
  const rel = path.join(codeDir, "releases");
  if (fs.existsSync(rel)) unlockTree(rel);
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  answer = "approve";
  prompts = [];
});

describe("capturing reusable code through Claude Code", () => {
  it("tells Claude when to suggest a capture, and when not to", () => {
    const text = client.getInstructions()!;
    expect(text).toContain("Capturing reusable code from a project");
    expect(text).toMatch(/Not for small helpers, glue code/);
    expect(text).toMatch(/at most once per piece of work/);
    expect(text).toMatch(/never link_component it unless it actually switches to the released copy/);
  });

  it("1-2. checks the library first: nothing does this yet", async () => {
    const r = await call("find_reusable_functionality", { description: "normalize and dedupe a list of email addresses" });
    expect(r.data.count).toBe(0);
  });

  it("3. proposes the capture without changing anything", async () => {
    const before = snapshot();
    const r = await call("propose_capture", { name: "Email Tools", category: "text-processing", sources: [src.reusable], capabilities: ["Email address normalization"] });
    expect(r.data.changed).toBe(false);
    expect(r.data.blockers).toEqual([]);
    expect(r.data.duplicates.verdict).toBe("none");
    expect(r.data.files.excluded.map((e: any) => e.path).sort()).toEqual(["email_tools/.env.local", "email_tools/__pycache__", "email_tools/subscribers.db"]);
    expect(r.data.sourceProject).toMatchObject({ registered: true, name: "Newsletter app" });
    expect(r.data.present).toContain("What must be separated from the original project");
    expect(prompts).toEqual([]); // read-only: no approval needed, none asked
    expect(snapshot()).toEqual(before);
  });

  it("does not encourage capturing a trivial or app-bound function", async () => {
    const trivial = await call("propose_capture", { name: "Slug", sources: [src.trivial] });
    expect(trivial.data.signals[0]).toMatch(/^Small/);
    const tied = await call("propose_capture", { name: "Sign up", sources: [src.tied] });
    expect(tied.data.signals.join(" ")).toMatch(/Tied to its application/);
    expect(tied.data.reachesOutside.length).toBe(2);
  });

  it("4. declining the capture leaves the project and the library unchanged", async () => {
    const before = snapshot();
    answer = "decline";
    const r = await call("register_component", { ...CAPTURE, sources: [src.reusable], origin_project: src.root });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/No change was made\. The user declined/);
    expect(prompts).toHaveLength(1);
    expect(snapshot()).toEqual(before);
  });

  it("refuses credentials before asking, so nothing can be approved by mistake", async () => {
    const leaky = path.join(tmp, "newsletter-app", "app", "leaky_tools");
    fs.cpSync(src.reusable, leaky, { recursive: true });
    fs.writeFileSync(path.join(leaky, "send.py"), 'password = "Summer2026!Summer"\n');
    const r = await call("register_component", { ...CAPTURE, name: "Leaky", sources: [leaky], origin_project: src.root });
    expect(r.text).toMatch(/Nothing was copied: 1 line\(s\) look like credentials: leaky_tools\/send\.py:1/);
    expect(prompts).toEqual([]);
    fs.rmSync(leaky, { recursive: true });
    sourceHash = treeHash(src.root);
  });

  it("4-5. approving copies it into the library, records the origin, and shows what is left out", async () => {
    const r = await call("register_component", { ...CAPTURE, sources: [src.reusable], origin_project: src.root });
    expect(r.isError, r.text).toBe(false);
    expect(prompts[0].split("\n")[0]).toBe(`Register "Email Tools" in "Text Processing" from ${src.reusable}, copying it into the shared folder?`);
    expect(prompts[0]).toMatch(/4 file\(s\) will be COPIED into .*\/shared\/email-tools\. Originals are only read, never changed\. Left out: email_tools\/\.env\.local, email_tools\/__pycache__, email_tools\/subscribers\.db\./);
    expect(prompts[0]).toMatch(/Captured from: project "Newsletter app".*not as a project using it/);
    expect(r.data.registered.origin.project.name).toBe("Newsletter app");
    expect(treeHash(src.root)).toBe(sourceHash);

    const p = await call("get_project", { project: src.root });
    expect(p.data.components).toEqual([]);
    expect(p.data.originOf.map((c: any) => c.slug)).toEqual(["email-tools"]);
  });

  it("6. will not release before the tests pass", async () => {
    const r = await call("create_release", { component: "email-tools", version: "1.0.0", changes: "First release." });
    expect(r.text).toMatch(/Not released: Its tests have never been run/);
    expect(prompts).toEqual([]);
  });

  it("5. runs the tests in the library copy after approval", async () => {
    const r = await call("run_component_tests", { component: "email-tools" });
    expect(r.data.status, r.data.stderr).toBe("passed");
    expect(r.data.cwd).toBe(path.join(codeDir, "email-tools", "email_tools"));
  });

  it("6. declining the release creates nothing", async () => {
    answer = "decline";
    const before = snapshot();
    const r = await call("create_release", { component: "email-tools", version: "1.0.0", changes: "First release." });
    expect(r.text).toMatch(/No change was made/);
    expect(fs.existsSync(path.join(codeDir, "releases", "email-tools", "1.0.0"))).toBe(false);
    expect(snapshot()).toEqual(before);
  });

  it("6. approving the release freezes and records it", async () => {
    const r = await call("create_release", { component: "email-tools", version: "1.0.0", changes: "First release: normalize, validate, dedupe." });
    expect(r.isError, r.text).toBe(false);
    expect(prompts[0]).toMatch(/^Release Email Tools 1\.0\.0 from .*\/shared\/email-tools\? First release\./);
    expect(prompts[0]).toMatch(/Tests passed at .*; no file changed since/);
    expect((await call("verify_release", { component: "email-tools", version: "1.0.0" })).data.state).toBe("intact");
    const again = await call("create_release", { component: "email-tools", version: "1.0.0", changes: "Again." });
    expect(again.text).toMatch(/already exists\. Releases are never overwritten/);
  });

  it("8. another project finds it by describing what it needs", async () => {
    const r = await call("find_reusable_functionality", { description: "clean up and dedupe customer email addresses before importing them", project: src.root });
    expect(r.data.matches[0].component.slug).toBe("email-tools");
    expect(r.data.matches[0].latestRelease.version).toBe("1.0.0");
    expect(r.data.matches[0].usedByThisProject).toBeNull(); // the origin is not a user
    expect(r.data.matches[0].capturedFromThisProject).toMatch(/holds the original code/);
    const s = await call("search_components", { query: "validate email address" });
    expect(s.data.components.map((c: any) => c.slug)).toContain("email-tools");
  });

  it("8. the consumer runs the released copy on its own and is tracked at 1.0.0", async () => {
    const c = await call("get_component", { component: "email-tools" });
    const releasePath = c.data.releases[0].sourcePath;
    expect(c.data.releases[0].state).toBe("intact");
    fs.writeFileSync(path.join(consumer, "import_contacts.py"), [
      "import json, sys",
      `sys.path.insert(0, ${JSON.stringify(releasePath)})`,
      "from email_tools import dedupe, is_valid",
      "kept, rejected = dedupe(['Billing@Acme.io', 'billing@acme.io', 'not an email', 'm.lee+inv@gmail.com'])",
      "print(json.dumps({'kept': kept, 'rejected': rejected, 'valid': is_valid('x@y.co')}))",
    ].join("\n"));
    const out = JSON.parse(execFileSync("python3", ["-I", "import_contacts.py"], { cwd: consumer, encoding: "utf8" }));
    expect(out).toEqual({ kept: ["billing@acme.io", "mlee@gmail.com"], rejected: ["not an email"], valid: true });

    expect((await call("register_project", { path: consumer, name: "Invoice app (temporary)" })).isError).toBe(false);
    expect((await call("link_component", { project: consumer, component: "email-tools" })).isError).toBe(false);
    const p = await call("get_project", { project: consumer });
    expect(p.data.components[0]).toMatchObject({ slug: "email-tools", version: "1.0.0", latestVersion: "1.0.0", upgradeAvailable: false });
    expect((await call("verify_release", { component: "email-tools", version: "1.0.0" })).data.state).toBe("intact");
  });

  it("warns before recording the origin project as a user", async () => {
    answer = "decline";
    await call("link_component", { project: src.root, component: "email-tools" });
    expect(prompts[0]).toMatch(/"Newsletter app" is where this code was captured from\. Approve only if it now runs the released copy\./);
  });

  it("removes the temporary consumer through the approval workflow, and the source project never changed", async () => {
    const r = await call("unregister_project", { project: consumer });
    expect(r.isError, r.text).toBe(false);
    expect(prompts).toHaveLength(1);
    expect((await call("list_projects")).data.map((p: any) => p.name)).toEqual(["Newsletter app"]);
    expect(fs.existsSync(path.join(consumer, "import_contacts.py"))).toBe(true); // the folder itself is not touched
    expect(treeHash(src.root)).toBe(sourceHash);
  });
});
