/**
 * "Run": only recorded projects, only built-in commands, approval first, no
 * shell, and Stop ends only what Run started. A stand-in npx/npm that records
 * exactly what it was given and then waits; throwaway folders only. Nothing
 * real is ever started.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLibrary, type Library } from "../src/core";

let tmp: string;
let lib: Library;
let calls: string;
const strays: ChildProcess[] = [];
const keep = { ...process.env };
const KEYS = ["COMPONENT_LIBRARY_HOME", "COMPONENT_LIBRARY_CODE_DIR", "COMPONENT_LIBRARY_RUN_BIN_DIR", "FAKE_EXIT"];
/** A folder name built to run commands if it were ever handed to a shell. */
const WEIRD = `My "App" $HOME; touch name-ran-as-command 'x' & $(touch also-ran) \`touch backtick-ran\``;
const RAN = ["name-ran-as-command", "also-ran", "backtick-ran"];

/** What the stand-in program was given, one start per entry. */
const started = () =>
  fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { program: string; argv: string[]; cwd: string; port: string; pid: number }) : [];

async function until<T>(get: () => T | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Waits until something answers on this address. */
async function waitForPort(port: number, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const up = await new Promise<boolean>((r) => { const c = net.connect(port, "127.0.0.1"); c.once("connect", () => { c.destroy(); r(true); }); c.once("error", () => r(false)); });
    if (up) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`nothing answered on ${port}`);
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** By default a project every built-in command fits. */
const FITS_ALL = { dependencies: { expo: "57.0.0", next: "16.0.0" }, scripts: { dev: "next dev" } };

function project(name: string, folder = name, pkg: object = FITS_ALL) {
  const dir = path.join(tmp, "Projects", folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg) + "\n");
  return lib.projects.register({ path: dir, name });
}

function ranAnything() {
  const where = [tmp, path.join(tmp, "Projects"), ...fs.readdirSync(path.join(tmp, "Projects")).map((d) => path.join(tmp, "Projects", d))];
  return where.flatMap((d) => RAN.filter((f) => fs.existsSync(path.join(d, f))));
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cl-run-app-")));
  calls = path.join(tmp, "calls.jsonl");
  process.env.COMPONENT_LIBRARY_HOME = path.join(tmp, "home");
  process.env.COMPONENT_LIBRARY_CODE_DIR = path.join(tmp, "shared");
  // Stand-ins for npx and npm: record what they got, then wait until stopped.
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ["npx", "npm"]) {
    fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env node
require("fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ program: ${JSON.stringify(name)}, argv: process.argv.slice(2), cwd: process.cwd(), port: process.env.PORT, pid: process.pid }) + "\\n");
if (process.env.FAKE_EXIT) { console.error("Error: Couldn't find any pages or app directory"); process.exit(1); }
if (process.env.PORT) require("http").createServer((q, a) => a.end("ok")).listen(Number(process.env.PORT), "127.0.0.1");
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  }
  process.env.COMPONENT_LIBRARY_RUN_BIN_DIR = bin;
  lib = openLibrary(path.join(tmp, "home", "library.db"));
  lib.settings.update({ allowedRoots: [tmp], projectsRoot: path.join(tmp, "Projects") });
});

afterEach(async () => {
  for (const p of lib.projects.list()) await lib.run.stop(p.id).catch(() => {});
  for (const c of strays.splice(0)) { try { c.kill("SIGKILL"); } catch { /* gone */ } }
  lib.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of KEYS) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; }
});

describe("choosing and approving", () => {
  it("only accepts the built-in commands", () => {
    const p = project("app");
    expect(() => lib.run.setPreset(p.id, "sh -c 'touch should-never-run'")).toThrow(/Unknown run command/);
    expect(() => lib.run.setPreset(p.id, "toString")).toThrow(/Unknown run command/);
    expect(() => lib.run.setPreset(p.id, "__proto__")).toThrow(/Unknown run command/);
  });

  it("won't run before a command is chosen and approved", async () => {
    const p = project("app");
    await expect(lib.run.start(p.id)).rejects.toThrow(/Choose how this project runs/);
    lib.run.setPreset(p.id, "expo-web");
    await expect(lib.run.start(p.id)).rejects.toThrow(/Approve the run command/);
    expect(started()).toEqual([]);
  });

  it("shows the exact command before approval, and changing it needs approval again", async () => {
    const p = project("app");
    lib.run.setPreset(p.id, "expo-web");
    const s = await lib.run.status(p.id);
    expect(s.command).toBe("npx --no expo start --web --port 8090");
    expect(s.approved).toBe(false);
    lib.run.approve(p.id);
    expect((await lib.run.status(p.id)).approved).toBe(true);
    lib.run.setPreset(p.id, "npm-dev");
    expect((await lib.run.status(p.id)).approved).toBe(false);
  });

  it("only runs recorded projects", async () => {
    await expect(lib.run.start(path.join(tmp, "Projects", "not-recorded"))).rejects.toThrow();
    expect(started()).toEqual([]);
  });

  it("won't run a project whose folder is now outside the allowed folders", async () => {
    const p = project("app");
    lib.run.setPreset(p.id, "expo-web");
    lib.run.approve(p.id);
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cl-run-elsewhere-")));
    try {
      lib.settings.update({ allowedRoots: [elsewhere], projectsRoot: elsewhere });
      await expect(lib.run.start(p.id)).rejects.toThrow();
      expect(started()).toEqual([]);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("only commands that fit the project", () => {
  it("offers and accepts only the commands the project's package.json supports", async () => {
    const expoOnly = project("expo-app", "expo-app", { dependencies: { expo: "57.0.0" } });
    expect((await lib.run.status(expoOnly.id)).presets.map((x) => x.id)).toEqual(["expo-web"]);
    expect(() => lib.run.setPreset(expoOnly.id, "next-dev")).toThrow(/doesn't fit this project/);
    expect(() => lib.run.setPreset(expoOnly.id, "npm-dev")).toThrow(/doesn't fit this project/);
    const none = project("plain", "plain", {});
    expect((await lib.run.status(none.id)).presets).toEqual([]);
  });

  it("a command chosen earlier that no longer fits is treated as not chosen, and won't run", async () => {
    const p = project("app");
    lib.run.setPreset(p.id, "next-dev");
    lib.run.approve(p.id);
    fs.writeFileSync(path.join(p.path, "package.json"), JSON.stringify({ dependencies: { expo: "57.0.0" } }));
    expect((await lib.run.status(p.id)).preset).toBeNull();
    await expect(lib.run.start(p.id)).rejects.toThrow(/Choose how this project runs/);
    expect(started()).toEqual([]);
  });
});

describe("running", () => {
  it("an app that stops straight away is reported as stopped, with its error, never as running", async () => {
    const p = project("broken");
    lib.run.setPreset(p.id, "next-dev");
    lib.run.approve(p.id);
    process.env.FAKE_EXIT = "1";
    await expect(lib.run.start(p.id)).rejects.toThrow(/stopped right away: Error: Couldn't find any pages or app directory/);
    const s = await lib.run.status(p.id);
    expect(s.running).toBeNull();
    expect(s.ended).toMatch(/Couldn't find any pages or app directory/);
  });

  it("starts the built-in command in the project's folder, with no shell, and stops it", async () => {
    const p = project("app");
    lib.run.setPreset(p.id, "expo-web");
    lib.run.approve(p.id);
    const s = await lib.run.start(p.id);
    expect(s.running?.url).toMatch(/^http:\/\/localhost:80(9\d)$/);
    const call = await until(() => started()[0]);
    // npx always gets --no: it may only use what the project already has, never download.
    expect(call).toMatchObject({ program: "npx", argv: ["--no", "expo", "start", "--web", "--port", String(s.running!.port)], cwd: p.path, port: String(s.running!.port) });
    expect(s.running?.ready).toBe(true);
    await expect(lib.run.start(p.id)).rejects.toThrow(/already running/);

    const stopped = await lib.run.stop(p.id);
    expect(stopped.running).toBeNull();
    await until(() => !alive(call.pid) || undefined);
  });

  it("a folder name full of shell tricks is only ever the working folder", async () => {
    const p = project("weird", WEIRD);
    lib.run.setPreset(p.id, "npm-dev");
    lib.run.approve(p.id);
    await lib.run.start(p.id);
    const call = await until(() => started()[0]);
    expect(call.cwd).toBe(p.path);
    expect(call.argv).toEqual(["run", "dev"]);
    // If any part of the name had been run as a command, one of these files would exist.
    expect(ranAnything()).toEqual([]);
    await lib.run.stop(p.id);
  });
});

describe("already running elsewhere", () => {
  it("won't start a second copy when the project is already served from its folder outside Run, and says where", async () => {
    const p = project("app");
    lib.run.setPreset(p.id, "expo-web");
    lib.run.approve(p.id);
    // Started by hand (not by Run), in the project's own folder, answering on an address.
    const byHand = spawn(process.execPath, ["-e", "require('http').createServer((q, a) => a.end('ok')).listen(8095, '127.0.0.1')"], { cwd: p.path, stdio: "ignore" });
    strays.push(byHand);
    await waitForPort(8095);
    await expect(lib.run.start(p.id)).rejects.toThrow(/already running at localhost:8095, started outside Run/);
    expect(started()).toEqual([]);
  });

  it("can fail: a server in some other folder doesn't count", async () => {
    const p = project("app");
    lib.run.setPreset(p.id, "expo-web");
    lib.run.approve(p.id);
    const other = spawn(process.execPath, ["-e", "require('http').createServer((q, a) => a.end('ok')).listen(8096, '127.0.0.1')"], { cwd: tmp, stdio: "ignore" });
    strays.push(other);
    await waitForPort(8096);
    const s = await lib.run.start(p.id);
    expect(s.running).not.toBeNull();
  });
});

describe("stopping only what Run started", () => {
  const startOf = (pid: number) => { try { return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim(); } catch { return ""; } };
  function plant(projectId: string, pid: number, signature: string, processStart = startOf(pid)) {
    const file = path.join(tmp, "home", "runs.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ [projectId]: { pid, port: 8090, preset: "expo-web", startedAt: new Date().toISOString(), signature, processStart } }));
  }

  it("a group leader running the same command but started at a different moment is left alone", async () => {
    const p = project("app");
    // Exactly what Run would start (own group, same command), as if a later program had been given the old number.
    const later = spawn(path.join(tmp, "bin", "npx"), ["expo", "start", "--web", "--port", "8090"], { detached: true, stdio: "ignore" });
    strays.push(later);
    await until(() => started()[0]);
    plant(p.id, later.pid!, "expo start --web --port 8090", "Thu Jan  1 00:00:00 1970");
    expect((await lib.run.status(p.id)).running).toBeNull();
    await lib.run.stop(p.id);
    expect(alive(later.pid!)).toBe(true);
  });

  it("can fail: the same process with its real start time IS recognised as Run's", async () => {
    // Guards the test above: with every detail right, the check accepts it, so a pass there isn't vacuous.
    const p = project("app");
    const ours = spawn(path.join(tmp, "bin", "npx"), ["expo", "start", "--web", "--port", "8090"], { detached: true, stdio: "ignore" });
    strays.push(ours);
    await until(() => started()[0]);
    plant(p.id, ours.pid!, "expo start --web --port 8090");
    expect((await lib.run.status(p.id)).running).not.toBeNull();
  });

  it("a recorded number that now belongs to another program is forgotten, never signalled", async () => {
    const p = project("app");
    const other = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    strays.push(other);
    plant(p.id, other.pid!, "expo start --web --port 8090");
    expect((await lib.run.status(p.id)).running).toBeNull();
    await lib.run.stop(p.id);
    expect(alive(other.pid!)).toBe(true);
  });

  it("a process running the same command but not started by Run (not its own group leader) is left alone", async () => {
    const p = project("app");
    // Same command line, but in this test's process group: not something Run started.
    const lookalike = spawn(path.join(tmp, "bin", "npx"), ["expo", "start", "--web", "--port", "8090"], { stdio: "ignore" });
    strays.push(lookalike);
    await until(() => started()[0]);
    plant(p.id, lookalike.pid!, "expo start --web --port 8090");
    expect((await lib.run.status(p.id)).running).toBeNull();
    await lib.run.stop(p.id);
    expect(alive(lookalike.pid!)).toBe(true);
  });

  it("a record for a process that has ended is cleared", async () => {
    const p = project("app");
    const gone = spawn("/usr/bin/true", [], { stdio: "ignore" });
    await new Promise((r) => gone.once("exit", r));
    plant(p.id, gone.pid!, "expo start --web --port 8090");
    expect((await lib.run.status(p.id)).running).toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(tmp, "home", "runs.json"), "utf8"))).toEqual({});
  });
});
