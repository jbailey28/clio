/**
 * Protocol-level tests: a real MCP client talks to the real server process
 * (bin/component-library-mcp) over stdio, against a throwaway database.
 * The client plays the user's part in approval prompts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { openLibrary } from "../src/core";
import { unlockTree } from "../src/core/releases";

const BIN = path.resolve(import.meta.dirname, "../bin/component-library-mcp");
let tmp: string;
let codeDir: string;
let srcDir: string;
let projDir: string;
let client: Client;
let noPromptClient: Client;
let answer: "approve" | "untick" | "decline" | "cancel" = "approve";
let prompts: string[] = [];

async function connect(withElicitation: boolean) {
  const c = new Client({ name: "test", version: "1" }, { capabilities: withElicitation ? { elicitation: {} } : {} });
  if (withElicitation)
    c.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(String(req.params.message));
      if (answer === "decline" || answer === "cancel") return { action: answer };
      return { action: "accept", content: { approve: answer === "approve" } };
    });
  await c.connect(new StdioClientTransport({
    command: BIN,
    cwd: os.tmpdir(), // not the library folder
    env: { ...(process.env as Record<string, string>), COMPONENT_LIBRARY_HOME: tmp, COMPONENT_LIBRARY_CODE_DIR: codeDir },
    stderr: "ignore",
  }));
  return c;
}

const call = async (name: string, args: Record<string, unknown> = {}, c = client) => {
  const res = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const text = res.content[0].text;
  return { isError: !!res.isError, text, data: res.isError ? null : JSON.parse(text) };
};

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cl-mcp-")));
  codeDir = path.join(tmp, "shared-code");
  srcDir = path.join(tmp, "some-project", "src", "retry");
  projDir = path.join(tmp, "some-project");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, "retry.ts"), "export const retry = 1;\n");
  fs.writeFileSync(path.join(srcDir, ".env"), "SECRET=1\n");
  fs.mkdirSync(path.join(srcDir, "node_modules"));
  fs.writeFileSync(path.join(srcDir, "node_modules", "x.js"), "");
  // Set up through the service layer, as the browser would.
  const lib = openLibrary(path.join(tmp, "library.db"));
  lib.settings.update({ allowedRoots: [tmp] });
  lib.categories.create({ name: "Networking", description: "HTTP and sockets" });
  lib.db.close();
  client = await connect(true);
  noPromptClient = await connect(false);
});

afterAll(async () => {
  await client?.close();
  await noPromptClient?.close();
  const rel = path.join(codeDir, "releases");
  if (fs.existsSync(rel)) for (const slug of fs.readdirSync(rel)) for (const v of fs.readdirSync(path.join(rel, slug))) unlockTree(path.join(rel, slug, v));
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  answer = "approve";
  prompts = [];
});

const RETRY = {
  name: "Retry with backoff",
  category: "networking",
  summary: "Retries failed HTTP requests with exponential backoff",
  capabilities: [{ name: "Exponential backoff" }, { name: "Gives up after max attempts", kind: "check" }],
  dependencies: [{ type: "system", name: "node" }],
  test_command: "ls retry.ts && echo retry-ok",
};

describe("MCP server", () => {
  it("lists every tool with read-only / destructive metadata", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const readOnly = ["search_components", "find_reusable_functionality", "check_for_duplicates", "list_categories", "get_category", "get_component", "list_projects", "get_project", "compare_versions", "verify_release", "propose_capture"];
    const writes = ["create_category", "register_component", "update_component", "add_capability", "register_project", "link_component", "unlink_component", "run_component_tests", "record_release", "create_release", "set_project_version", "unregister_project"];
    expect(Object.keys(byName).sort()).toEqual([...readOnly, ...writes].sort());
    for (const n of readOnly) expect(byName[n].annotations?.readOnlyHint).toBe(true);
    for (const n of writes) expect(byName[n].annotations?.readOnlyHint).toBe(false);
    for (const n of ["update_component", "unlink_component", "run_component_tests", "unregister_project"]) expect(byName[n].annotations?.destructiveHint).toBe(true);
    expect(client.getInstructions()).toContain("proposal workflow");
  });

  it("refuses changes when the client cannot show an approval prompt", async () => {
    const r = await call("register_component", { ...RETRY, sources: [srcDir] }, noPromptClient);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("cannot show an approval prompt");
    expect((await call("search_components", { query: "retry" })).data.count).toBe(0);
  });

  it("makes no change when the user declines, cancels, or leaves approve unticked", async () => {
    for (const a of ["decline", "cancel", "untick"] as const) {
      answer = a;
      const r = await call("register_component", { ...RETRY, sources: [srcDir] });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("No change was made");
    }
    expect(prompts).toHaveLength(3);
    expect((await call("search_components", { query: "retry" })).data.count).toBe(0);
  });

  it("rejects bad input with a useful error before asking the user", async () => {
    const missing = await call("register_component", { ...RETRY, sources: [path.join(tmp, "nope")] });
    expect(missing.text).toMatch(/Nothing exists at .*\[PATH_INVALID\]/);
    const outside = await call("register_component", { ...RETRY, sources: ["/etc"] });
    expect(outside.text).toContain("outside the allowed folders");
    const badCat = await call("register_component", { ...RETRY, category: "nope", sources: [srcDir] });
    expect(badCat.text).toContain('Category not found: "nope"');
    const unknown = await call("get_component", { component: "does-not-exist" });
    expect(unknown).toMatchObject({ isError: true });
    expect(unknown.text).toContain("[NOT_FOUND]");
    expect(prompts).toHaveLength(0);
  });

  it("registers after approval, showing the user exactly what will be added", async () => {
    const r = await call("register_component", { ...RETRY, sources: [srcDir] });
    expect(r.isError).toBe(false);
    expect(r.data.registered.slug).toBe("retry-with-backoff");
    expect(prompts[0].split("\n")[0]).toBe(`Register "Retry with backoff" in "Networking" from ${srcDir}?`);
    expect(prompts[0]).toContain(srcDir);
    expect(prompts[0]).toContain("Test command (stored, not run): ls retry.ts");
  });

  it("finds it by search, natural language, and full details", async () => {
    expect((await call("search_components", { query: "backoff", category: "networking" })).data.count).toBe(1);
    const nl = await call("find_reusable_functionality", { description: "I need something that retries a failed http request" });
    expect(nl.data.matches[0].component.slug).toBe("retry-with-backoff");
    expect(nl.data.matches[0].matchedTerms).toEqual(expect.arrayContaining(["retry", "fail", "http"]));
    const none = await call("find_reusable_functionality", { description: "render a pie chart" });
    expect(none.data.count).toBe(0);

    const d = (await call("get_component", { component: "retry-with-backoff" })).data;
    expect(d.sources[0]).toMatchObject({ path: srcDir, status: "present" });
    expect(d.capabilities.map((c: any) => c.kind)).toEqual(["capability", "check"]);
    expect(d.testEvidence).toBe("No test has ever been run. Test status is unknown.");
    expect((await call("get_category", { category: "networking" })).data.components).toHaveLength(1);
    expect((await call("list_categories")).data[0]).toMatchObject({ name: "Networking", componentCount: 1 });
  });

  it("flags duplicates", async () => {
    const dup = await call("check_for_duplicates", { name: "Retry with backoff" });
    expect(dup.data.exact[0].slug).toBe("retry-with-backoff");
    const similar = await call("check_for_duplicates", { name: "HTTP retrier", summary: "retry failed requests" });
    expect(similar.data.similar[0].component.slug).toBe("retry-with-backoff");
    const again = await call("register_component", { ...RETRY, sources: [srcDir] });
    expect(again.text).toContain("already exists");
    expect(prompts).toHaveLength(0);
  });

  it("adds a capability and updates fields, showing a before/after", async () => {
    const add = await call("add_capability", { component: "retry-with-backoff", name: "Jitter", description: "randomises waits" });
    expect(add.data.updated.capabilities.map((c: any) => c.name)).toEqual(["Exponential backoff", "Gives up after max attempts", "Jitter"]);
    expect((await call("add_capability", { component: "retry-with-backoff", name: "jitter" })).text).toContain("already has");

    const up = await call("update_component", { component: "retry-with-backoff", summary: "Retries with jitter" });
    expect(up.data.updated.summary).toBe("Retries with jitter");
    expect(prompts.at(-1)).toContain("Retries failed HTTP requests with exponential backoff  →  Retries with jitter");
    expect(up.data.updated.capabilities).toHaveLength(3); // untouched list stays
    expect((await call("update_component", { component: "retry-with-backoff" })).text).toContain("Nothing to change");
  });

  it("registers a project and links / unlinks a component", async () => {
    const before = fs.readdirSync(projDir);
    const p = (await call("register_project", { path: projDir })).data.registered;
    const linked = await call("link_component", { project: projDir, component: "retry-with-backoff", note: "API client" });
    expect(linked.data.project.components[0]).toMatchObject({ slug: "retry-with-backoff", note: "API client" });
    expect((await call("get_component", { component: "retry-with-backoff" })).data.projects[0].projectId).toBe(p.id);
    expect((await call("list_projects")).data[0]).toMatchObject({ componentCount: 1 });
    expect((await call("link_component", { project: p.id, component: "retry-with-backoff" })).text).toContain("already uses");
    expect((await call("unlink_component", { project: p.id, component: "retry-with-backoff" })).data.project.components).toEqual([]);
    expect(fs.readdirSync(projDir)).toEqual(before);
  });

  it("runs tests only after approval of the exact command, and returns the real result", async () => {
    answer = "decline";
    const no = await call("run_component_tests", { component: "retry-with-backoff" });
    expect(no.text).toContain("No change was made");
    expect(prompts[0]).toContain("ls retry.ts && echo retry-ok");
    expect(prompts[0]).toContain(`in ${srcDir}`);
    expect((await call("get_component", { component: "retry-with-backoff" })).data.testRuns).toEqual([]);

    answer = "approve";
    const yes = await call("run_component_tests", { component: "retry-with-backoff" });
    expect(yes.data).toMatchObject({ status: "passed", exitCode: 0 });
    expect(yes.data.stdout).toContain("retry-ok");

    await call("update_component", { component: "retry-with-backoff", test_command: "echo nope >&2; exit 4" });
    const bad = await call("run_component_tests", { component: "retry-with-backoff" });
    expect(bad.data).toMatchObject({ status: "failed", exitCode: 4 });
    expect(bad.data.stderr).toContain("nope");
  });

  it("packages sources into the shared folder without secrets or dependencies", async () => {
    const r = await call("register_component", {
      name: "Packaged retry", category: "networking", sources: [srcDir], package_into_library: true,
    });
    expect(r.isError).toBe(false);
    const folder = path.join(codeDir, "packaged-retry");
    expect(r.data.registered.sources[0].path).toBe(path.join(folder, "retry"));
    expect(fs.readdirSync(path.join(folder, "retry"))).toEqual(["retry.ts"]);
    expect(fs.existsSync(path.join(srcDir, ".env"))).toBe(true); // original untouched
    expect(prompts[0]).toContain("COPIED into");
    const clash = await call("register_component", { name: "Other", slug: "packaged-retry", category: "networking", sources: [srcDir], package_into_library: true });
    expect(clash.text).toContain("already used");
    const folderClash = await call("register_component", { name: "Other", slug: "other-retry", category: "networking", sources: [srcDir], package_into_library: true });
    expect(folderClash.isError).toBe(false); // different slug, different folder
    fs.mkdirSync(path.join(codeDir, "third"));
    const exists = await call("register_component", { name: "Third", category: "networking", sources: [srcDir], package_into_library: true });
    expect(exists.text).toContain("already exists, so nothing was copied");
    expect(prompts).toHaveLength(2); // the two refusals never reached the user
  });

  it("records releases with approval, tracks project versions, and never upgrades them", async () => {
    // Freeze two versions the way scripts/release.ts does (files only, no library record).
    const prev = process.env.COMPONENT_LIBRARY_CODE_DIR;
    process.env.COMPONENT_LIBRARY_CODE_DIR = codeDir;
    const svc = openLibrary(path.join(tmp, "library.db"));
    const v1 = svc.releases.snapshot({ slug: "retry-with-backoff", version: "1.0.0", from: srcDir });
    fs.writeFileSync(path.join(srcDir, "jitter.ts"), "export const jitter = 1;\n");
    const v2 = svc.releases.snapshot({ slug: "retry-with-backoff", version: "1.1.0", from: srcDir });
    svc.db.close();
    process.env.COMPONENT_LIBRARY_CODE_DIR = prev;

    answer = "decline";
    expect((await call("record_release", { component: "retry-with-backoff", version: "1.0.0", path: v1.path, changes: "first" })).text).toContain("No change was made");
    answer = "approve";
    expect((await call("record_release", { component: "retry-with-backoff", version: "1.0.0", path: v1.path, changes: "First release." })).isError).toBe(false);
    expect(prompts.at(-1)).toContain("First recorded release.");

    const proj = (await call("get_project", { project: projDir })).data;
    await call("link_component", { project: proj.id, component: "retry-with-backoff", version: "1.0.0" });
    expect(prompts.at(-1)).toContain('uses "Retry with backoff" 1.0.0');

    const rec = await call("record_release", { component: "retry-with-backoff", version: "1.1.0", path: v2.path, changes: "Adds jitter. Compatible." });
    expect(rec.isError).toBe(false);
    expect(prompts.at(-1)).toContain("1 project(s) use it; they stay on their recorded version.");

    const after = (await call("get_project", { project: proj.id })).data.components[0];
    expect(after).toMatchObject({ version: "1.0.0", latestVersion: "1.1.0", upgradeAvailable: true });
    const comp = (await call("get_component", { component: "retry-with-backoff" })).data;
    expect(comp.latestVersion).toBe("1.1.0");
    expect(comp.releases.map((r: any) => [r.version, r.state])).toEqual([["1.1.0", "intact"], ["1.0.0", "intact"]]);

    const diff = (await call("compare_versions", { component: "retry-with-backoff", from: "1.0.0" })).data;
    expect(diff).toMatchObject({ to: "1.1.0", upToDate: false, majorChange: false });
    expect(diff.releases.map((r: any) => r.changes)).toEqual(["Adds jitter. Compatible."]);
    expect((await call("verify_release", { component: "retry-with-backoff", version: "1.0.0" })).data.state).toBe("intact");

    expect((await call("record_release", { component: "retry-with-backoff", version: "1.0.5", path: v1.path, changes: "x" })).text).toContain("must be newer");
    expect((await call("set_project_version", { project: proj.id, component: "retry-with-backoff", version: "9.9.9" })).text).toContain("not a recorded release");

    answer = "decline";
    expect((await call("set_project_version", { project: proj.id, component: "retry-with-backoff", version: "1.1.0" })).text).toContain("No change was made");
    expect((await call("get_project", { project: proj.id })).data.components[0].version).toBe("1.0.0");
    answer = "approve";
    const up = await call("set_project_version", { project: proj.id, component: "retry-with-backoff", version: "1.1.0" });
    expect(up.data.project.components[0]).toMatchObject({ version: "1.1.0", upgradeAvailable: false });

    const gone = await call("unregister_project", { project: proj.id });
    expect(gone.isError).toBe(false);
    expect(fs.existsSync(projDir)).toBe(true);
  });
});
