import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLibrary, type Library } from "../src/core";
import { compareVersions } from "../src/core/semver";
import { unlockTree } from "../src/core/releases";

let tmp: string;
let lib: Library;
let dev: string;
let proj: string;
const prevCodeDir = process.env.COMPONENT_LIBRARY_CODE_DIR;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cl-rel-")));
  process.env.COMPONENT_LIBRARY_CODE_DIR = path.join(tmp, "library");
  dev = path.join(tmp, "library", "widget");
  proj = path.join(tmp, "consumer");
  fs.mkdirSync(path.join(dev, "src"), { recursive: true });
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(dev, "src", "widget.py"), "VERSION = '1.0.0'\n");
  fs.writeFileSync(path.join(dev, "run.sh"), "#!/bin/sh\necho widget\n", { mode: 0o755 });
  fs.mkdirSync(path.join(dev, "__pycache__"));
  fs.writeFileSync(path.join(dev, "__pycache__", "x.pyc"), "junk");
  lib = openLibrary(path.join(tmp, "db", "library.db"));
  lib.settings.update({ allowedRoots: [tmp] });
  lib.categories.create({ name: "Tools" });
  lib.components.create({ name: "Widget", category: "tools", version: "1.0.0", sources: [dev] });
});

afterEach(() => {
  lib.db.close();
  const rel = path.join(tmp, "library", "releases");
  if (fs.existsSync(rel)) for (const slug of fs.readdirSync(rel)) for (const v of fs.readdirSync(path.join(rel, slug))) unlockTree(path.join(rel, slug, v));
  fs.rmSync(tmp, { recursive: true, force: true });
  if (prevCodeDir === undefined) delete process.env.COMPONENT_LIBRARY_CODE_DIR;
  else process.env.COMPONENT_LIBRARY_CODE_DIR = prevCodeDir;
});

const release = (version: string, changes = `changes in ${version}`) => {
  const snap = lib.releases.snapshot({ slug: "widget", version, from: dev });
  return { snap, rec: lib.releases.record("widget", { version, path: snap.path, changes }) };
};

describe("versions", () => {
  it("compares semantic versions numerically", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.1.0", "1.1.0")).toBe(0);
    expect(() => compareVersions("1.1", "1.0.0")).toThrow(/not a version/);
    expect(() => compareVersions("v1.0.0", "1.0.0")).toThrow(/not a version/);
  });
});

describe("releases", () => {
  it("snapshots a read-only copy with a manifest, skipping caches", () => {
    const { snap, rec } = release("1.0.0");
    expect(snap.path).toBe(path.join(tmp, "library", "releases", "widget", "1.0.0"));
    expect(fs.readdirSync(snap.path).sort()).toEqual(["RELEASE.json", "run.sh", "src"]);
    expect(fs.statSync(path.join(snap.path, "src", "widget.py")).mode & 0o222).toBe(0);
    expect(fs.statSync(path.join(snap.path, "run.sh")).mode & 0o777).toBe(0o555); // still runnable, not writable
    expect(() => fs.writeFileSync(path.join(snap.path, "src", "widget.py"), "x")).toThrow();
    const manifest = JSON.parse(fs.readFileSync(path.join(snap.path, "RELEASE.json"), "utf8"));
    expect(manifest).toMatchObject({ component: "widget", version: "1.0.0", checksum: rec.checksum });
    expect(rec).toMatchObject({ version: "1.0.0", fileCount: 2 });
  });

  it("never overwrites a release and refuses older or duplicate versions", () => {
    release("1.0.0");
    expect(() => lib.releases.snapshot({ slug: "widget", version: "1.0.0", from: dev })).toThrow(/never overwritten/);
    fs.writeFileSync(path.join(dev, "src", "widget.py"), "VERSION = '1.1.0'\n");
    release("1.1.0");
    const old = lib.releases.snapshot({ slug: "widget", version: "0.9.0", from: dev });
    expect(() => lib.releases.record("widget", { version: "0.9.0", path: old.path, changes: "x" })).toThrow(/must be newer than the latest release, 1.1.0/);
    expect(() => lib.releases.record("widget", { version: "1.1.0", path: old.path, changes: "x" })).toThrow(/already recorded/);
    expect(() => lib.releases.record("widget", { version: "1.2.0", path: old.path, changes: "  " })).toThrow(/Change notes are required/);
    expect(lib.releases.list("widget").map((r) => r.version)).toEqual(["1.1.0", "1.0.0"]);
    expect(lib.components.get("widget").version).toBe("1.1.0");
  });

  it("detects a release whose files changed, and refuses to record one", () => {
    const { snap } = release("1.0.0");
    expect(lib.releases.verify("widget", "1.0.0").state).toBe("intact");
    unlockTree(snap.path);
    fs.writeFileSync(path.join(snap.path, "src", "widget.py"), "tampered\n");
    expect(lib.releases.verify("widget", "1.0.0").state).toBe("changed");
    const other = lib.releases.snapshot({ slug: "widget", version: "2.0.0", from: dev });
    unlockTree(other.path);
    fs.writeFileSync(path.join(other.path, "src", "extra.py"), "added after snapshot\n");
    expect(() => lib.releases.record("widget", { version: "2.0.0", path: other.path, changes: "x" })).toThrow(/no longer match its RELEASE.json/);
  });

  it("reports a missing release folder as missing", () => {
    const { snap } = release("1.0.0");
    unlockTree(snap.path);
    fs.rmSync(snap.path, { recursive: true });
    expect(lib.releases.verify("widget", "1.0.0").state).toBe("missing");
  });
});

describe("project versions", () => {
  it("records the version a project uses and never upgrades it automatically", () => {
    release("1.0.0", "first release");
    const p = lib.projects.register({ path: proj });
    lib.projects.link(p.id, "widget", "uses it");
    expect(lib.projects.get(p.id).components[0]).toMatchObject({ version: "1.0.0", latestVersion: "1.0.0", upgradeAvailable: false });

    fs.writeFileSync(path.join(dev, "src", "widget.py"), "VERSION = '1.1.0'\n");
    release("1.1.0", "added the frobnicate check");
    const link = lib.projects.get(p.id).components[0];
    expect(link).toMatchObject({ version: "1.0.0", latestVersion: "1.1.0", upgradeAvailable: true });
    expect(lib.components.get("widget").projects[0]).toMatchObject({ version: "1.0.0", latestVersion: "1.1.0", upgradeAvailable: true });

    expect(lib.releases.changesBetween("widget", "1.0.0").map((r) => [r.version, r.changes])).toEqual([["1.1.0", "added the frobnicate check"]]);

    expect(() => lib.projects.setVersion(p.id, "widget", "1.5.0")).toThrow(/not a recorded release/);
    expect(() => lib.projects.setVersion(p.id, "widget", "1.0.0")).toThrow(/already recorded at 1.0.0/);
    lib.projects.setVersion(p.id, "widget", "1.1.0");
    expect(lib.projects.get(p.id).components[0]).toMatchObject({ version: "1.1.0", upgradeAvailable: false });
    expect(fs.readdirSync(proj)).toEqual([]); // the project folder is never touched
  });

  it("links to the newest release by default, or an older one on request", () => {
    release("1.0.0");
    release("1.1.0");
    const p = lib.projects.register({ path: proj });
    lib.projects.link(p.id, "widget", "", "1.0.0");
    expect(lib.projects.get(p.id).components[0].version).toBe("1.0.0");
    lib.projects.unlink(p.id, "widget");
    lib.projects.link(p.id, "widget");
    expect(lib.projects.get(p.id).components[0].version).toBe("1.1.0");
    lib.projects.unlink(p.id, "widget");
    expect(() => lib.projects.link(p.id, "widget", "", "3.0.0")).toThrow(/not a recorded release/);
  });

  it("without releases, a link records the component's version number", () => {
    const p = lib.projects.register({ path: proj });
    lib.projects.link(p.id, "widget");
    expect(lib.projects.get(p.id).components[0]).toMatchObject({ version: "1.0.0", latestVersion: "", upgradeAvailable: false });
  });
});
