import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db";
import { LibraryError, invalid } from "./errors";
import { getComponent } from "./components";
import { inspectRelease } from "./inspect";
import { checkPath } from "./paths";
import { getProject, linkComponent, setIntegration } from "./projects";
import { MANIFEST, getRelease, listReleases, treeChecksum, verifyRelease } from "./releases";
import { componentCalls, sandboxedTraceCommand } from "./sandbox";
import { getSettings } from "./settings";
import { runShell } from "./testing";

/**
 * Putting a component's code into a project, the way Salesrunner holds
 * Website Analysis: the frozen release copied byte for byte into
 * components/<slug>/ (with its RELEASE.json), never edited. The release
 * itself is only read.
 *
 * Added: the files are in the project. Connected: the project's tests ran in
 * the sandbox and called the component. Recording a link is neither.
 */

export interface ComponentCopy {
  slug: string;
  version: string;
  /** Folders (relative to the project) to put on sys.path. */
  importRoots: string[];
  packages: string[];
  api: string[];
  checksum: string;
}

/** Slugs of components that have at least one release (only releases can be copied). */
export function listComponentsWithReleases(db: DB): string[] {
  return (db.prepare("SELECT DISTINCT c.slug FROM components c JOIN component_releases r ON r.component_id = c.id ORDER BY c.slug").all() as { slug: string }[]).map((r) => r.slug);
}

const walk = (dir: string, base = dir): string[] => fs.readdirSync(dir).sort().flatMap((n) => {
  const f = path.join(dir, n);
  return fs.lstatSync(f).isDirectory() ? walk(f, base) : [path.relative(base, f)];
});

/** Copies release `version` of a component into <projectDir>/components/<slug>/. Refuses if that folder exists or the release changed. */
export function writeComponentCopy(db: DB, projectDir: string, componentRef: string, version: string): ComponentCopy {
  const c = getComponent(db, componentRef);
  const r = getRelease(db, c.id, version);
  if (verifyRelease(db, c.id, version).state !== "intact") throw new LibraryError("VALIDATION", `${c.name} ${version}'s release files no longer match their checksum, so it was not copied.`);
  const ins = inspectRelease(db, c.id, version);
  if (!ins.packages.length) throw invalid(`No Python package was found in ${c.name} ${version}, so it can't be used from a project.`);
  const dest = path.join(projectDir, "components", c.slug);
  if (fs.existsSync(dest)) throw new LibraryError("CONFLICT", `${dest} already exists, so nothing was copied. Existing files are never overwritten.`);
  fs.mkdirSync(dest, { recursive: true });
  try {
    for (const rel of walk(r.sourcePath)) {
      const out = path.join(dest, rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.copyFileSync(path.join(r.sourcePath, rel), out, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(out, 0o644); // releases are read-only; the project's copy is ordinary files (its contents are what's checked)
    }
    const checksum = treeChecksum(dest).checksum;
    if (checksum !== r.checksum) throw new LibraryError("VALIDATION", `The copy of ${c.name} ${version} doesn't match the release, so it was removed.`);
    return {
      slug: c.slug, version, checksum, packages: ins.packages.map((p) => p.name), api: ins.api.map((f) => f.name),
      importRoots: [...new Set(ins.packages.map((p) => path.join("components", c.slug, p.importRoot === "." ? "" : p.importRoot).replace(/\/$/, "")))],
    };
  } catch (err) {
    fs.rmSync(dest, { recursive: true, force: true }); // only the folder made just now
    throw err;
  }
}

/** The small file that lets project code import its copied components. Written by the library, not the AI. */
export function componentPathsFile(copies: ComponentCopy[]): string {
  return `"""Lets this project import the library components copied (unchanged) into components/.

Written by Component Library. Import it before any component:  import component_paths
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
for _root in ${JSON.stringify(copies.flatMap((c) => c.importRoots))}:
    _path = os.path.join(_HERE, _root)
    if _path not in sys.path:
        sys.path.insert(0, _path)
`;
}

/** A test, in the project, that its component copies still match their releases byte for byte. */
export function matchTestFile(copies: ComponentCopy[]): string {
  return `"""Checks that each library component in components/ is still exactly its release. Written by Component Library."""
import hashlib
import json
import os
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPECTED = ${JSON.stringify(Object.fromEntries(copies.map((c) => [c.slug, c.version])))}


class ComponentsMatchTheirReleases(unittest.TestCase):
    def test_each_copy_is_its_release(self):
        for slug, version in EXPECTED.items():
            folder = os.path.join(ROOT, "components", slug)
            with open(os.path.join(folder, "${MANIFEST}"), encoding="utf-8") as f:
                manifest = json.load(f)
            self.assertEqual((manifest["component"], manifest["version"]), (slug, version))
            listed = set()
            for entry in manifest["files"]:
                listed.add(entry["path"])
                with open(os.path.join(folder, entry["path"]), "rb") as f:
                    self.assertEqual(hashlib.sha256(f.read()).hexdigest(), entry["sha256"], f"{slug}: {entry['path']} was changed")
            for dirpath, dirnames, filenames in os.walk(folder):
                dirnames[:] = [d for d in dirnames if d != "__pycache__"]
                for name in filenames:
                    rel = os.path.relpath(os.path.join(dirpath, name), folder)
                    if rel != "${MANIFEST}":
                        self.assertIn(rel, listed, f"{slug}: {rel} was added")


if __name__ == "__main__":
    unittest.main()
`;
}

// ---------- existing projects ----------

/** What adding would do, for the review screen. Reads only. */
export function previewAdd(db: DB, projectRef: string, componentRef: string, version?: string) {
  const p = getProject(db, projectRef);
  const c = getComponent(db, componentRef);
  const v = version?.trim() || listReleases(db, c.id)[0]?.version;
  if (!v) throw invalid(`${c.name} has no release yet, so there is nothing to copy.`);
  const ins = inspectRelease(db, c.id, v);
  const dest = path.join(p.path, "components", c.slug);
  const problems: string[] = [];
  if (p.pathStatus === "missing") problems.push(`The project folder ${p.path} isn't there now.`);
  if (fs.existsSync(dest)) problems.push(`${dest} already exists. Existing files are never overwritten.`);
  if (ins.release !== "intact") problems.push(`${c.name} ${v}'s release files no longer match their checksum.`);
  if (!ins.packages.length) problems.push(`No Python package was found in ${c.name} ${v}.`);
  const link = p.components.find((l) => l.componentId === c.id);
  if (link?.version && link.version !== v) problems.push(`"${p.name}" is recorded at ${c.name} ${link.version}. Change its version on the Components tab first, or add ${link.version}.`);
  const root = ins.packages[0] ? path.join("components", c.slug, ins.packages[0].importRoot === "." ? "" : ins.packages[0].importRoot).replace(/\/$/, "") : "";
  const example = ins.api[0];
  const snippet = ins.packages[0]
    ? `import os, sys\nsys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ${JSON.stringify(root)}))\n\nfrom ${ins.packages[0].name} import ${ins.api.slice(0, 3).map((f) => f.name).join(", ") || "..."}${example ? `\n\n# ${example.name}${example.signature}${example.doc ? ` — ${example.doc}` : ""}` : ""}`
    : "";
  const files = walk(getRelease(db, c.id, v).sourcePath);
  return { project: p, component: c, version: v, dest, files, problems, snippet, inspection: ins };
}

/** Copies the release into a new components/<slug>/ folder in the project, and records it as Added. Never touches the project's other files. */
export function addComponentToProject(db: DB, projectRef: string, componentRef: string, version?: string) {
  const preview = previewAdd(db, projectRef, componentRef, version);
  if (preview.problems.length) throw invalid(preview.problems.join(" "));
  const p = preview.project;
  checkPath(db, p.path, "directory");
  const copy = writeComponentCopy(db, p.path, preview.component.id, preview.version);
  try {
    db.transaction(() => {
      if (!p.components.some((l) => l.componentId === preview.component.id))
        linkComponent(db, p.id, preview.component.id, `Copied unchanged into components/${copy.slug}/.`, preview.version);
      setIntegration(db, p.id, preview.component.id, "added", `${preview.component.name} ${preview.version} was copied unchanged into components/${copy.slug}/. The project's code hasn't been checked for using it yet.`);
    })();
  } catch (err) {
    fs.rmSync(path.join(p.path, "components", copy.slug), { recursive: true, force: true }); // only the folder made just now
    throw err;
  }
  return { ...preview, copy };
}

/**
 * Runs the project's own tests (tests/test_*.py) in the sandbox and records
 * whether they called the component. Connected only if they pass, the copy
 * still matches its release, and the component's functions were called.
 */
export async function checkConnection(db: DB, projectRef: string, componentRef: string) {
  const p = getProject(db, projectRef);
  const c = getComponent(db, componentRef);
  const link = p.components.find((l) => l.componentId === c.id);
  if (!link) throw invalid(`"${p.name}" doesn't use "${c.name}".`);
  const dir = path.join(p.path, "components", c.slug);
  let verdict: "added" | "connected" = "added";
  let detail: string;
  let output = "";
  if (!fs.existsSync(dir)) detail = `There is no components/${c.slug}/ folder in the project, so it can't be checked.`;
  else if (treeChecksum(dir).checksum !== getRelease(db, c.id, link.version).checksum) detail = `components/${c.slug}/ no longer matches ${c.name} ${link.version}: its files were changed.`;
  else if (!fs.existsSync(path.join(p.path, "tests")) || !fs.readdirSync(path.join(p.path, "tests")).some((f) => /^test_.+\.py$/.test(f)))
    detail = "The project has no tests (tests/test_*.py), so whether it really uses the component can't be checked.";
  else {
    const run = await runShell(sandboxedTraceCommand(), p.path, getSettings(db).testTimeoutSeconds * 1000);
    output = `${run.stdout}\n${run.stderr}`.trim();
    const calls = componentCalls(run.stdout)[c.slug] ?? [];
    if (run.status !== "passed") detail = `The project's tests ${run.status}, so the connection isn't verified.`;
    else if (!calls.length) detail = "The project's tests passed but never called the component, so it isn't connected yet.";
    else { verdict = "connected"; detail = `The project's passing tests called ${calls.join(", ")} in the sandbox.`; }
  }
  setIntegration(db, p.id, c.id, verdict, detail);
  return { integration: verdict, detail, output };
}
