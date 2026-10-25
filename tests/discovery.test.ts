/**
 * Discovery: finding the right component from ordinary language, and saying
 * honestly when something is only related or nothing fits. Every library
 * here is a throwaway one; see tests/discovery/fixtures.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluate, viaBrowser, viaFunctionality } from "./discovery/evaluate";
import { makeLibrary, OVERLAPPING, WEBSITE_ANALYSIS, type Temp } from "./discovery/fixtures";
import { CASES } from "./discovery/cases";

let full: Temp;
let waOnly: Temp;

beforeAll(() => {
  full = makeLibrary([WEBSITE_ANALYSIS, ...OVERLAPPING]);
  waOnly = makeLibrary([WEBSITE_ANALYSIS]);
});
afterAll(() => {
  full.close();
  waOnly.close();
});

const top = (t: Temp, q: string) => t.lib.discovery.find(q).results[0];

describe("evaluation set", () => {
  it("has at least 40 realistic searches of every kind", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40);
    const kinds = new Set(CASES.map((c) => c.kind));
    for (const k of ["name", "capability", "everyday", "synonym", "technical", "short", "sentence", "misspelling", "unrelated", "partial"])
      expect(kinds).toContain(k);
  });

  it.each([
    ["with overlapping fixtures", () => full],
    ["with Website Analysis alone", () => waOnly],
  ])("scores well %s, through the MCP search and the browser search", (_, lib) => {
    for (const searcher of [viaFunctionality, viaBrowser]) {
      const s = evaluate(lib().lib, searcher);
      const failures = s.details.filter((d) => d.topCorrect === false || d.falsePositive || d.wrongStrong).map((d) => d.c.q);
      expect(s.retrieval / s.relevantCases).toBeGreaterThanOrEqual(0.95);
      expect(s.topCorrect / s.relevantCases, failures.join(" | ")).toBeGreaterThanOrEqual(0.95);
      expect(s.capCorrect).toBe(s.capCases);
      expect(s.falsePositives).toBe(0);
      expect(s.wrongStrong).toBe(0);
    }
  });
});

describe("what a match says", () => {
  it("names the capability, the version and why", () => {
    const m = top(full, "I want to detect whether a company uses Intercom.");
    expect(m.component.slug).toBe("website-analysis");
    expect(m.strength).toBe("strong");
    expect(m.capability?.name).toBe("Support chat detection");
    expect(m.component.version).toBe("1.1.0");
    expect(m.why).toContain("Support chat detection");
    expect(m.why).toContain("intercom");
  });

  it("finds the same component through different capabilities, once each time", () => {
    for (const [q, cap] of [
      ["is this brand on Klaviyo or Mailchimp", "Email and SMS detection"],
      ["which payment gateway does this shop use", "Payments and checkout detection"],
      ["does this company have a live chat widget", "Support chat detection"],
    ]) {
      const results = full.lib.discovery.find(q).results;
      expect(results.filter((r) => r.component.slug === "website-analysis")).toHaveLength(1);
      expect(results[0].capability?.name, q).toBe(cap);
    }
  });

  it("names no capability when the whole component is the answer", () => {
    expect(top(waOnly, "What technology is this website running?").capability).toBeNull();
  });

  it("corrects small misspellings and says so", () => {
    const d = full.lib.discovery.find("detect ecomerce platfrom");
    expect(d.query.corrections).toEqual([{ from: "ecomerce", to: "ecommerce" }, { from: "platfrom", to: "platform" }]);
    expect(d.results[0].capability?.name).toBe("Ecommerce platform detection");
  });

  it("does not 'correct' ordinary words into library words", () => {
    for (const q of ["generate PDF invoices", "store and manage my sales contacts", "user login and password reset"])
      expect(full.lib.discovery.find(q).query.corrections, q).toEqual([]);
  });
});

describe("the same subject, a different job", () => {
  it("detecting review tools is not analyzing reviews", () => {
    const r = full.lib.discovery.find("Analyze customer reviews.").results;
    expect(r[0].component.slug).toBe("review-sentiment");
    const wa = r.find((m) => m.component.slug === "website-analysis");
    expect(wa?.strength).toBe("related");
    expect(wa?.why).toMatch(/different job/);
    // and the other way round
    expect(top(full, "which reviews widget does this store use").component.slug).toBe("website-analysis");
  });

  it("detecting email marketing software is not sending newsletters", () => {
    const send = full.lib.discovery.find("Build a newsletter sending system.").results;
    expect(send[0].component.slug).toBe("newsletter-sender");
    expect(send.find((m) => m.component.slug === "website-analysis")?.strength).toBe("related");
    const detect = full.lib.discovery.find("What email marketing platform does this brand use?").results;
    expect(detect[0].component.slug).toBe("website-analysis");
    expect(detect[0].capability?.name).toBe("Email and SMS detection");
    expect(detect.find((m) => m.component.slug === "newsletter-sender")?.strength).toBe("related");
  });

  it("detecting a chat widget is not building one", () => {
    const r = waOnly.lib.discovery.find("build a live chat widget for my site").results;
    expect(r.every((m) => m.strength === "related")).toBe(true);
  });

  it("an unrelated request returns nothing at all", () => {
    for (const q of ["Create an authentication system.", "resize images into thumbnails", "parse a CSV file into rows"])
      expect(full.lib.discovery.find(q).results, q).toEqual([]);
  });

  it("a partial match says what it does not cover", () => {
    const m = top(full, "parse script src hosts from html and match them against a fingerprint library");
    expect(m.strength).toBe("partial");
    expect(m.unmatched.length).toBeGreaterThan(0);
    expect(m.fit).toMatch(/part of the request/);
  });
});

describe("before building something new", () => {
  const verdict = (name: string, summary: string) => full.lib.components.findDuplicates({ name, summary }).verdict;

  it("tells exact, partial, related and none apart", () => {
    expect(verdict("Website Analysis", "")).toBe("exact");
    expect(verdict("Chat detector", "detect which live chat widget a website uses")).toBe("exact");
    expect(verdict("Script matcher", "parse script src hosts from html and match them against a fingerprint library")).toBe("partial");
    expect(verdict("Chat widget", "build a live chat widget for websites")).toBe("related");
    expect(verdict("Auth kit", "login, sessions and password resets")).toBe("none");
  });

  it("does not tell the caller to stop when the match is only related", () => {
    const r = full.lib.components.findDuplicates({ name: "Chat widget", summary: "build a live chat widget for websites" });
    expect(r.advice).toMatch(/does not prevent building/);
  });
});

describe("project context", () => {
  it("says whether a project already uses a match", () => {
    const t = makeLibrary([WEBSITE_ANALYSIS]);
    try {
      const p = t.lib.projects.register({ name: "Demo", path: t.dir });
      const m = top(t, "detect whether a company uses Zendesk");
      expect(t.lib.discovery.context(m, p.id).usedByProject).toBeNull();
      t.lib.db.prepare("INSERT INTO project_components (project_id, component_id, note, created_at, version) VALUES (?, ?, '', ?, '1.1.0')")
        .run(p.id, m.component.id, new Date().toISOString());
      expect(t.lib.discovery.context(m, p.id).usedByProject).toEqual({ project: "Demo", version: "1.1.0" });
      expect(t.lib.discovery.context(m).usedByProject).toBeUndefined();
    } finally {
      t.close();
    }
  });
});
