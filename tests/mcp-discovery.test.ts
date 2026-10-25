/**
 * Discovery over the real MCP protocol: the server process, started in a
 * registered project's folder, against a throwaway library holding Website
 * Analysis and the overlapping fixtures.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeLibrary, OVERLAPPING, WEBSITE_ANALYSIS, type Temp } from "./discovery/fixtures";

const BIN = path.resolve(import.meta.dirname, "../bin/component-library-mcp");
let t: Temp;
let projDir: string;
let client: Client;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return JSON.parse(res.content[0].text);
};

beforeAll(async () => {
  t = makeLibrary([WEBSITE_ANALYSIS, ...OVERLAPPING]);
  projDir = path.join(t.dir, "sales-app");
  fs.mkdirSync(projDir);
  const p = t.lib.projects.register({ name: "Sales app", path: projDir });
  const wa = t.lib.components.get("website-analysis");
  t.lib.db.prepare("INSERT INTO project_components (project_id, component_id, note, created_at, version) VALUES (?, ?, '', ?, '1.1.0')")
    .run(p.id, wa.id, new Date().toISOString());
  client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: BIN,
    cwd: projDir,
    env: { ...(process.env as Record<string, string>), COMPONENT_LIBRARY_HOME: path.join(t.dir, "db") },
    stderr: "ignore",
  }));
});

afterAll(async () => {
  await client?.close();
  t.close();
});

describe("find_reusable_functionality", () => {
  it("finds the capability from ordinary words, with everything needed to act on it", async () => {
    const r = await call("find_reusable_functionality", { description: "I want to detect whether a company uses Intercom." });
    expect(r.count).toBeGreaterThan(0);
    const m = r.matches[0];
    expect(m.component.slug).toBe("website-analysis");
    expect(m.strength).toBe("strong");
    expect(m.capability.name).toBe("Support chat detection");
    expect(m.version).toBe("1.1.0");
    expect(m.why).toMatch(/Support chat detection/);
    expect(m.inspect.next).toContain('get_component "website-analysis"');
    expect(m.inspect.sources[0]).toContain(t.dir);
    // Older callers still find what they used to.
    expect(m.matchedCapabilities[0]).toBe("Support chat detection");
    expect(typeof m.score).toBe("number");
  });

  it("knows the project it was started in already uses it", async () => {
    const r = await call("find_reusable_functionality", { description: "which payment processor does this store use" });
    expect(r.projectContext).toEqual({ project: "Sales app", from: "working directory" });
    expect(r.matches[0].usedByThisProject).toEqual({ project: "Sales app", version: "1.1.0" });
  });

  it("keeps related components apart from matches", async () => {
    const r = await call("find_reusable_functionality", { description: "Analyze customer reviews." });
    expect(r.matches[0].component.slug).toBe("review-sentiment");
    expect(r.matches.map((m: any) => m.component.slug)).not.toContain("website-analysis");
    expect(r.related.map((m: any) => m.component.slug)).toContain("website-analysis");
  });

  it("says plainly when nothing fits", async () => {
    const r = await call("find_reusable_functionality", { description: "Create an authentication system." });
    expect(r).toMatchObject({ count: 0, matches: [], related: [] });
    expect(r.note).toBe("Nothing in the library matches this request.");
    const g = await call("find_reusable_functionality", { description: "build a live chat widget for my site" });
    expect(g.count).toBe(0);
    expect(g.note).toMatch(/not solutions/);
  });
});

describe("search_components", () => {
  it("still lists components, now ranked and explained", async () => {
    const r = await call("search_components", { query: "intercom" });
    expect(r.components[0].slug).toBe("website-analysis");
    expect(r.matches[0]).toMatchObject({ slug: "website-analysis", strength: "strong", capability: "Support chat detection" });
    const all = await call("search_components", {});
    expect(all.count).toBe(6);
    const cat = await call("search_components", { query: "detection", category: "website-research" });
    expect(cat.components.every((c: any) => c.categorySlug === "website-research")).toBe(true);
  });
});

describe("check_for_duplicates", () => {
  it("gives a verdict and advice, and never forbids building", async () => {
    const exact = await call("check_for_duplicates", { name: "Chat detector", summary: "detect which live chat widget a website uses" });
    expect(exact.verdict).toBe("exact");
    expect(exact.similar[0].component.slug).toBe("website-analysis");
    const related = await call("check_for_duplicates", { name: "Chat widget", summary: "build a live chat widget for websites" });
    expect(related.verdict).toBe("related");
    expect(related.advice).toMatch(/does not prevent building/);
    const none = await call("check_for_duplicates", { name: "Auth kit", summary: "login, sessions and password resets" });
    expect(none).toMatchObject({ verdict: "none", exact: [], similar: [] });
  });
});
