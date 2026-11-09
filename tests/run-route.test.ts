/**
 * The Run web address end to end: the real POST handler, with browser headers
 * a page on another site would send. Nothing may start, stop or change unless
 * the request comes from this app's own pages. Stand-in programs only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({})); // the route's server-only marker, which blocks imports outside Next

let tmp: string;
let calls: string;
const keep = { ...process.env };
const started = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean) : []);
const g = globalThis as unknown as { __componentLibrary?: { db: { close(): void }; run: { stop(id: string): Promise<unknown> } } };

let route: typeof import("../app/api/run/route");
let projectId: string;

function post(action: string, headers: Record<string, string>) {
  const body = new FormData();
  body.set("project", projectId);
  body.set("action", action);
  return route.POST(new Request("http://127.0.0.1:4410/api/run", { method: "POST", body, headers: { host: "127.0.0.1:4410", ...headers } }));
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cl-run-route-")));
  calls = path.join(tmp, "calls.jsonl");
  process.env.COMPONENT_LIBRARY_HOME = path.join(tmp, "home");
  process.env.COMPONENT_LIBRARY_CODE_DIR = path.join(tmp, "shared");
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "npx"), `#!/usr/bin/env node
require("fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.env.PORT) require("http").createServer((q, a) => a.end("ok")).listen(Number(process.env.PORT), "127.0.0.1");
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  process.env.COMPONENT_LIBRARY_RUN_BIN_DIR = bin;
  delete g.__componentLibrary;
  route = await import("../app/api/run/route");
  const { getLib } = await import("../src/web/lib");
  const lib = getLib();
  lib.settings.update({ allowedRoots: [tmp], projectsRoot: path.join(tmp, "Projects") });
  const dir = path.join(tmp, "Projects", "app");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { expo: "57.0.0" } }));
  projectId = lib.projects.register({ path: dir, name: "app" }).id;
  lib.run.setPreset(projectId, "expo-web");
  lib.run.approve(projectId);
});

afterAll(async () => {
  await g.__componentLibrary?.run.stop(projectId).catch(() => {});
  g.__componentLibrary?.db.close();
  delete g.__componentLibrary;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of ["COMPONENT_LIBRARY_HOME", "COMPONENT_LIBRARY_CODE_DIR", "COMPONENT_LIBRARY_RUN_BIN_DIR"]) {
    if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k];
  }
});

describe("the Run web address", () => {
  it("only answers POST", () => {
    expect(Object.keys(route).filter((k) => /^(GET|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(k))).toEqual([]);
  });

  it.each([
    ["a page on another site", { "sec-fetch-site": "cross-site", origin: "https://evil.example" }],
    ["a sibling site", { "sec-fetch-site": "same-site" }],
    ["another origin with no fetch header", { origin: "https://evil.example" }],
    ["a sandboxed page", { origin: "null" }],
    ["a look-alike host", { host: "127.0.0.1.evil.example" }],
  ])("refuses %s and starts nothing", async (_who, headers) => {
    const res = await post("start", headers as Record<string, string>);
    expect(res.status).toBe(403);
    expect(started()).toEqual([]);
  });

  it("can fail: this app's own page does start it, and stop it", async () => {
    const res = await post("start", { "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:4410" });
    expect(res.status).toBe(200);
    expect((await res.json()).running).not.toBeNull();
    const end = Date.now() + 5000;
    while (!started().length && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(started()).toHaveLength(1);
    const stop = await post("stop", { "sec-fetch-site": "same-origin" });
    expect((await stop.json()).running).toBeNull();
  });
});
