/**
 * End-to-end acceptance run against a real production server on its own port
 * and its own throwaway data folder. It submits the same forms the browser
 * does and reads the same pages. Requires `npm run build` first.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openLibrary } from "../src/core";
import { unlockTree } from "../src/core/releases";

const PORT = 4411;
const BASE = `http://127.0.0.1:${PORT}`;
const APP = path.resolve(import.meta.dirname, "..");
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cl-acceptance-")));
const projectDir = path.join(home, "existing-project");
fs.mkdirSync(projectDir);
fs.writeFileSync(path.join(projectDir, "README.md"), "untouched\n");
const realSource = path.join(APP, "src/core/paths.ts");

let server: ChildProcess | null = null;
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${detail}` : ""}`);
  if (!ok) failures++;
};

async function start() {
  server = spawn(path.join(APP, "node_modules/.bin/next"), ["start", "-H", "127.0.0.1", "-p", String(PORT)], {
    cwd: APP,
    env: { ...process.env, COMPONENT_LIBRARY_HOME: home, COMPONENT_LIBRARY_CODE_DIR: path.join(home, "code"), COMPONENT_LIBRARY_TRASH: path.join(home, "Trash") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout!.on("data", (d) => (log += d));
  server.stderr!.on("data", (d) => (log += d));
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/help`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server did not start on ${PORT}:\n${log}`);
}
async function stop() {
  if (!server) return;
  const s = server;
  server = null;
  await new Promise<void>((resolve) => { s.once("exit", () => resolve()); s.kill("SIGTERM"); });
}

/** Posts a form exactly like the browser without JavaScript: 303 redirect. */
async function submit(op: string, fields: Record<string, string>, returnTo = "/") {
  const body = new URLSearchParams({ op, returnTo, ...fields });
  const res = await fetch(`${BASE}/api/do`, { method: "POST", body, redirect: "manual" });
  return { status: res.status, location: res.headers.get("location") ?? "" };
}
/** Posts like the browser with JavaScript: JSON back. */
async function submitJson(op: string, fields: Record<string, string>) {
  const body = new URLSearchParams({ op, ...fields });
  const res = await fetch(`${BASE}/api/do`, { method: "POST", body, headers: { "x-fetch": "1" } });
  return { status: res.status, ...(await res.json()) } as { status: number; ok: boolean; error?: string; redirect?: string };
}
const page = async (p: string) => {
  const r = await fetch(`${BASE}${p}`);
  return { status: r.status, html: (await r.text()).replace(/<!-- -->/g, "") };
};
const decoded = (loc: string) => decodeURIComponent(loc.replace(/\+/g, " "));

async function main() {
  console.log(`Data folder: ${home}\n`);
  await start();
  check("app starts and serves Home", (await page("/")).status === 200);

  // The throwaway data folder lives outside your home folder, so allow it (and the app folder) first.
  let r = await submit("settings.update", { allowedRoots: `${home}\n${APP}`, testTimeoutSeconds: "120" });
  check("settings saved", r.status === 303 && r.location.startsWith("/settings?ok"), r.location);

  r = await submit("category.create", { name: "Safety", description: "Guards and validators" });
  check("create a category", r.location === "/categories/safety", r.location);
  check("category shows on Categories page", (await page("/categories")).html.includes("Safety"));

  r = await submit("component.create", {
    name: "Path guard",
    category: "safety",
    summary: "Validates filesystem paths before anything touches them",
    language: "TypeScript",
    sources: realSource,
    capabilities: "Resolve symlinks :: returns the real path\ncheck: Inside allowed folders :: refuses anything outside",
    inputs: "input (string) :: path typed by the user",
    outputs: "result (CheckedPath)",
    dependencies: "system: node",
    testCommand: `npx vitest run tests/services.test.ts -t "allowed folders"`,
    testCwd: APP,
  }, "/components/new");
  check("register a real component with a source path", r.location.startsWith("/components/path-guard"), decoded(r.location));
  let comp = await page("/components/path-guard");
  check("component page shows the real source path, found on disk", comp.html.includes(realSource) && comp.html.includes("found on disk"));
  check("untested component says 'not run', not 'failed'", comp.html.includes("tests not run") && !comp.html.includes("tests failed"));

  for (const q of ["path guard", "symlinks", "validates filesystem", "allowed folders"]) {
    check(`Home search finds it by "${q}"`, (await page(`/?q=${encodeURIComponent(q)}`)).html.includes('href="/components/path-guard"'));
  }
  check("Home search also finds categories", (await page("/?q=guards")).html.includes('href="/categories/safety"'));
  check("Categories search covers categories only", !(await page("/categories?q=path")).html.includes("Path guard"));

  r = await submit("component.update", { ref: "path-guard", summary: "EDITED: checks paths", capabilities: "Resolve symlinks :: edited description" });
  check("edit the component", r.location.includes("ok="), decoded(r.location));

  // Restart the server and confirm the edit is still there.
  await stop();
  await start();
  comp = await page("/components/path-guard");
  check("edit persists after restart", comp.html.includes("EDITED: checks paths") && comp.html.includes("edited description"));
  check("edit replaced the capability list as asked", !comp.html.includes("Inside allowed folders"));

  r = await submit("project.register", { path: projectDir, name: "Existing project" }, "/projects/new");
  const projectUrl = r.location.split("?")[0];
  check("register an existing project folder", /^\/projects\/prj_/.test(projectUrl), decoded(r.location));
  const projectId = projectUrl.split("/").pop()!;

  r = await submit("project.link", { project: projectId, component: "path-guard", note: "validates config paths" }, projectUrl);
  check("associate the component with the project", r.location.includes("ok="), decoded(r.location));
  // The component list, its notes and the version controls are on the project's Components tab.
  const proj = await page(`${projectUrl}?tab=components`);
  check("project page shows the component", proj.html.includes('href="/components/path-guard"') && proj.html.includes("validates config paths"));
  const usage = await page("/components/path-guard?tab=usage");
  check("component Usage tab shows the project", usage.html.includes(`href="/projects/${projectId}"`) && usage.html.includes("Existing project"));
  check("project folder was not modified", JSON.stringify(fs.readdirSync(projectDir)) === '["README.md"]');

  // Useful errors
  const bad = await submit("component.create", { name: "Ghost", category: "safety", sources: "/definitely/not/here" }, "/components/new");
  check("missing source path is refused with a clear message (no-JS form)", decoded(bad.location).includes("Nothing exists at"), decoded(bad.location));
  const rel = await submitJson("project.register", { path: "relative/folder" });
  check("relative project path is refused (JS form)", rel.status === 400 && !!rel.error?.startsWith("Path must be absolute"), rel.error);
  check("expected errors are shown plainly, not as a crash", !rel.error?.includes("Something went wrong"), rel.error);
  const outside = await submitJson("project.register", { path: "/etc" });
  check("folder outside allowed folders is refused", !!outside.error?.includes("outside the allowed folders"), outside.error);
  const file = await submitJson("project.register", { path: realSource });
  check("a file is refused as a project folder", !!file.error?.includes("a directory is required"), file.error);
  const dup = await submitJson("project.register", { path: projectDir });
  check("registering the same folder twice is refused", !!dup.error?.includes("already registered"), dup.error);
  const del = await submitJson("component.delete", { ref: "path-guard", confirm: "delete" });
  check("deleting a component in use is refused", !!del.error?.includes("Remove it from those projects first"), del.error);
  const delCat = await submitJson("category.delete", { ref: "safety" });
  check("deleting a non-empty category is refused", !!delCat.error?.includes("still has 1"), delCat.error);
  const ghost = await submitJson("component.create", { name: "Ghost", category: "safety", sources: "/definitely/not/here" });
  check("failed create leaves nothing behind", ghost.ok === false && (await page("/components/ghost")).status === 404);
  check("unknown page is a 404", (await page("/components/nope")).status === 404);

  // Real test run
  const t = await submitJson("component.test", { ref: "path-guard" });
  check("test run completes", t.ok === true, t.error);
  const tests = await page("/components/path-guard?tab=tests");
  check("Tests tab shows a real passing run with its output", tests.html.includes("tests passed") && tests.html.includes("Tests"), tests.html.slice(0, 200));

  r = await submit("project.unlink", { project: projectId, component: "path-guard" }, projectUrl);
  check("remove the association", r.location.includes("ok="));
  check("relationship gone from component side", !(await page("/components/path-guard?tab=usage")).html.includes(`href="/projects/${projectId}"`));

  // Versions: freeze two releases through the service layer (as scripts/release.ts does),
  // then check the browser shows them and never moves a project on its own.
  process.env.COMPONENT_LIBRARY_CODE_DIR = path.join(home, "code");
  const relSrc = path.join(home, "released-code");
  fs.mkdirSync(relSrc);
  fs.writeFileSync(path.join(relSrc, "guard.ts"), "export const v = 1;\n");
  const svc = openLibrary(path.join(home, "library.db"));
  const v1 = svc.releases.snapshot({ slug: "path-guard", version: "1.0.0", from: relSrc });
  svc.releases.record("path-guard", { version: "1.0.0", path: v1.path, changes: "First release." });
  r = await submit("project.link", { project: projectId, component: "path-guard", version: "1.0.0" }, projectUrl);
  check("link a project at a specific version", r.location.includes("ok="), decoded(r.location));
  fs.writeFileSync(path.join(relSrc, "guard.ts"), "export const v = 2;\n");
  const v2 = svc.releases.snapshot({ slug: "path-guard", version: "1.1.0", from: relSrc });
  svc.releases.record("path-guard", { version: "1.1.0", path: v2.path, changes: "Adds a second guard. Compatible." });
  svc.db.close();
  const ov = await page("/components/path-guard");
  check("Overview lists both releases, intact, with change notes", ov.html.includes("Adds a second guard. Compatible.") && ov.html.includes("First release.") && (ov.html.match(/>intact</g) ?? []).length === 2);
  let pv = await page(`${projectUrl}?tab=components`);
  check("project still records 1.0.0 after 1.1.0 was released", pv.html.includes("<code>1.0.0</code>") && pv.html.includes("1.1.0 available"));
  check("component Usage tab shows the newer version is available", (await page("/components/path-guard?tab=usage")).html.includes("1.1.0 available"));
  const badVer = await submitJson("project.setVersion", { project: projectId, component: "path-guard", version: "7.0.0" });
  check("setting an unreleased version is refused", !!badVer.error?.includes("not a recorded release"), badVer.error);
  r = await submit("project.setVersion", { project: projectId, component: "path-guard", version: "1.1.0" }, projectUrl);
  pv = await page(`${projectUrl}?tab=components`);
  check("setting the version by hand upgrades it, and the badge goes away", r.location.includes("ok=") && pv.html.includes("<code>1.1.0</code>") && !pv.html.includes("available</span>"));
  for (const v of [v1.path, v2.path]) unlockTree(v);

  check("Recently Used lists the component", (await page("/recent")).html.includes('href="/components/path-guard"'));
  for (const p of ["/", "/categories", "/categories/safety", "/components/path-guard?tab=configuration", "/recent", "/projects", "/settings", "/help"])
    check(`page ${p} renders`, (await page(p)).status === 200);
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(async () => {
    await stop();
    fs.rmSync(home, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll acceptance checks passed");
    process.exit(failures ? 1 : 0);
  });
