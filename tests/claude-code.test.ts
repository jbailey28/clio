/**
 * "Open in Claude Code": only recorded projects, the folder from the record,
 * the claude program found on the server, paths that can't break out of the
 * command, honest results, and nothing in the project changed. A stand-in
 * Claude Code and a stand-in Terminal launcher; throwaway folders only.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLibrary, type Library } from "../src/core";
import { TERMINAL_SCRIPT, manualCommand, shellQuote } from "../src/core/claudeCode";
import { treeChecksum } from "../src/core/releases";

let tmp: string;
let lib: Library;
let launches: string;
const keep = { ...process.env };
const KEYS = ["COMPONENT_LIBRARY_HOME", "COMPONENT_LIBRARY_CODE_DIR", "CLAUDE_CLI", "COMPONENT_LIBRARY_TERMINAL_LAUNCHER", "COMPONENT_LIBRARY_PLATFORM", "COMPONENT_LIBRARY_CLAUDE_CONFIG", "FAKE_AUTH", "FAKE_LAUNCH"];
const WEIRD = `My "Proj" $HOME; touch name-ran-as-command 'x' & é \`whoami\``;

/** What the stand-in launcher was given, one launch per entry. */
const launched = () => (fs.existsSync(launches) ? fs.readFileSync(launches, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);

function project(name: string, folder = name) {
  const dir = path.join(tmp, "Projects", folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "main.py"), "print('hi')\n");
  return lib.projects.register({ path: dir, name });
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cl-claude-code-")));
  launches = path.join(tmp, "launches.jsonl");
  process.env.COMPONENT_LIBRARY_HOME = path.join(tmp, "home");
  process.env.COMPONENT_LIBRARY_CODE_DIR = path.join(tmp, "shared");
  // A stand-in claude: answers only "auth status --json", from FAKE_AUTH (in / out / broken).
  const cli = path.join(tmp, "bin", "claude");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, `#!/bin/sh
[ "$1 $2 $3" = "auth status --json" ] || { echo "unexpected: $*" >&2; exit 2; }
case "$FAKE_AUTH" in out) echo '{"loggedIn": false}';; broken) echo 'not json';; *) echo '{"loggedIn": true, "email": "secret@example.com"}';; esac
`, { mode: 0o755 });
  process.env.CLAUDE_CLI = cli;
  // A stand-in Terminal: records exactly the arguments it got; FAKE_LAUNCH=fail / denied makes it fail.
  const launcher = path.join(tmp, "bin", "launch");
  fs.writeFileSync(launcher, `#!/usr/bin/env node
const fs = require("fs");
if (process.env.FAKE_LAUNCH === "denied") { console.error("execution error: Not authorized to send Apple events to Terminal. (-1743)"); process.exit(1); }
if (process.env.FAKE_LAUNCH === "fail") { console.error("Terminal got an error"); process.exit(1); }
fs.appendFileSync(${JSON.stringify(launches)}, JSON.stringify(process.argv.slice(2)) + "\\n");
`, { mode: 0o755 });
  process.env.COMPONENT_LIBRARY_TERMINAL_LAUNCHER = launcher;
  process.env.COMPONENT_LIBRARY_PLATFORM = "darwin";
  process.env.COMPONENT_LIBRARY_CLAUDE_CONFIG = path.join(tmp, "claude.json"); // none yet: MCP not configured
  lib = openLibrary(path.join(tmp, "home", "library.db"));
  lib.settings.update({ allowedRoots: [tmp], projectsRoot: path.join(tmp, "Projects") });
});

afterEach(() => {
  lib.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of KEYS) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; }
});

describe("opening a project", () => {
  it("opens a recorded project's own folder with the installed claude, and changes nothing in it", async () => {
    const p = project("app");
    const before = treeChecksum(p.path).checksum;
    const r = await lib.claudeCode.open(p.id);
    expect(r).toMatchObject({ launched: true, auth: { loggedIn: true, problem: null }, folder: { ok: true } });
    expect(r.message).toMatch(/Terminal opened in the project folder and started Claude Code/);
    expect(launched()).toEqual([[p.path, process.env.CLAUDE_CLI]]); // only these two values, from the server
    expect(JSON.stringify(r)).not.toContain("secret@example.com"); // account details never leave
    expect(treeChecksum(p.path).checksum).toBe(before);
  });

  it("works for a project made by Create project", async () => {
    process.env.COMPONENT_LIBRARY_GENERATOR = `node ${path.resolve(import.meta.dirname, "create/fake-generator.mjs")}`;
    try {
      const d = await lib.projectCreation.start("A tool that plans my meals for the week");
      await lib.projectCreation.analyze(d.id);
      await lib.projectCreation.build(d.id);
      await lib.projectCreation.test(d.id);
      await lib.projectCreation.create(d.id);
      const made = lib.projectCreation.get(d.id).project!;
      expect((await lib.claudeCode.open(made.id)).launched).toBe(true);
      expect(launched()[0][0]).toBe(made.path);
    } finally { delete process.env.COMPONENT_LIBRARY_GENERATOR; }
  });

  it("only projects in the library can be opened", async () => {
    await expect(lib.claudeCode.open("prj_doesnotexist")).rejects.toThrow(/not found/i);
    await expect(lib.claudeCode.open("/etc")).rejects.toThrow(/not found/i);
    expect(launched()).toEqual([]);
  });

  it("a folder with spaces, quotes and shell characters reaches Terminal exactly, and can't break out of the command", async () => {
    const p = project("Weird", WEIRD);
    expect((await lib.claudeCode.open(p.id)).launched).toBe(true);
    expect(launched()[0][0]).toBe(p.path);
    // The real Terminal script, with "do script" swapped for "return", run by macOS's own AppleScript: the command it would type.
    const script = TERMINAL_SCRIPT.replace(/tell application "Terminal"\s+activate\s+do script ([^\n]+)\s+end tell/, "return $1");
    expect(script).not.toBe(TERMINAL_SCRIPT);
    const typed = execFileSync("/usr/bin/osascript", ["-e", script, p.path, "/bin/pwd"], { encoding: "utf8" }).trim();
    expect(execFileSync("/bin/sh", ["-c", typed], { encoding: "utf8", cwd: tmp }).trim()).toBe(p.path); // lands in that folder, runs nothing else
    // And the copyable command does the same.
    expect(execFileSync("/bin/sh", ["-c", manualCommand(p.path, "macos").replace(/ claude$/, " pwd")], { encoding: "utf8", cwd: tmp }).trim()).toBe(p.path);
    // If either command had run part of the folder name as a command, the "touch name-ran-as-command" hidden in the folder name would have made this file.
    expect(fs.existsSync(path.join(tmp, "name-ran-as-command"))).toBe(false);
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("when it can't open", () => {
  it("a moved or deleted folder says the saved location can't be found", async () => {
    const p = project("gone");
    fs.rmSync(p.path, { recursive: true });
    const r = await lib.claudeCode.open(p.id);
    expect(r).toMatchObject({ launched: false, folder: { ok: false } });
    expect(r.message).toMatch(/saved location can't be found/);
    expect(launched()).toEqual([]);
  });

  it("a folder outside the allowed folders isn't opened", async () => {
    const p = project("app");
    lib.db.prepare("UPDATE settings SET value = ? WHERE key = 'allowedRoots'").run(JSON.stringify([path.join(tmp, "elsewhere")]));
    const r = await lib.claudeCode.open(p.id);
    expect(r.launched).toBe(false);
    expect(r.message).toMatch(/outside the allowed folders/);
  });

  it("without Claude Code installed it says how to get it, and launches nothing", async () => {
    const p = project("app");
    process.env.CLAUDE_CLI = path.join(tmp, "bin", "no-such-claude");
    const r = await lib.claudeCode.open(p.id);
    expect(r).toMatchObject({ launched: false, cli: { found: false } });
    expect(r.message).toMatch(/isn't installed.*claude\.com\/claude-code/);
    expect(launched()).toEqual([]);
  });

  it("not signed in: it still opens (Claude Code asks to sign in) and says so; an unreadable status is reported as unknown", async () => {
    process.env.FAKE_AUTH = "out";
    const r = await lib.claudeCode.open(project("a").id);
    expect(r).toMatchObject({ launched: true, auth: { loggedIn: false } });
    expect(r.message).toMatch(/isn't signed in yet, so it will ask you to sign in/);
    process.env.FAKE_AUTH = "broken";
    const u = await lib.claudeCode.open(project("b").id);
    expect(u).toMatchObject({ launched: true, auth: { loggedIn: null } });
    expect(u.message).toMatch(/Sign-in couldn't be checked/);
  });

  it("if Terminal can't be opened, it says so and gives the command to copy, never claiming it opened", async () => {
    const p = project("app");
    process.env.FAKE_LAUNCH = "denied";
    const denied = await lib.claudeCode.open(p.id);
    expect(denied).toMatchObject({ launched: false, command: manualCommand(p.path, "macos") });
    expect(denied.message).toMatch(/didn't allow this app to control Terminal.*Automation/);
    process.env.FAKE_LAUNCH = "fail";
    const failed = await lib.claudeCode.open(p.id);
    expect(failed.launched).toBe(false);
    expect(failed.message).toMatch(/couldn't be opened automatically/);
    delete process.env.FAKE_LAUNCH;
    expect((await lib.claudeCode.open(p.id)).launched).toBe(true); // a failure doesn't block trying again
  });

  it("a second click right away doesn't open a second window", async () => {
    const p = project("app");
    const [a, b] = await Promise.all([lib.claudeCode.open(p.id), lib.claudeCode.open(p.id)]);
    const c = await lib.claudeCode.open(p.id);
    expect([a, b, c].filter((x) => x.launched)).toHaveLength(1);
    expect([a, b, c].find((x) => !x.launched)!.message).toMatch(/opened a moment ago/);
    expect(launched()).toHaveLength(1);
  });

  it("on Windows and Linux it gives the command for that system instead of launching", async () => {
    const p = project("Spaced", "my project");
    process.env.COMPONENT_LIBRARY_PLATFORM = "linux";
    const linux = await lib.claudeCode.open(p.id);
    expect(linux).toMatchObject({ launched: false, platform: { name: "linux", canLaunch: false }, command: `cd '${p.path}' && claude` });
    expect(linux.message).toMatch(/only works on macOS/);
    process.env.COMPONENT_LIBRARY_PLATFORM = "win32";
    expect((await lib.claudeCode.open(p.id)).command).toBe(`cd /d "${p.path}" && claude`);
    expect(launched()).toEqual([]);
  });
});

describe("the MCP connection", () => {
  it("is reported when Claude Code already has it (user, local or project), and never changed", async () => {
    const p = project("app");
    expect((await lib.claudeCode.check(p.id)).mcp).toEqual({ configured: false, where: null }); // not set up: still opens
    expect((await lib.claudeCode.open(p.id)).launched).toBe(true);
    const cfg = process.env.COMPONENT_LIBRARY_CLAUDE_CONFIG!;
    fs.writeFileSync(cfg, JSON.stringify({ projects: { [p.path]: { mcpServers: { mine: { command: "/x/bin/component-library-mcp" } } } } }));
    expect((await lib.claudeCode.check(p.id)).mcp).toEqual({ configured: true, where: "local" });
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { "component-library": { command: "x" } } }));
    expect((await lib.claudeCode.check(p.id)).mcp).toEqual({ configured: true, where: "user" });
    const written = fs.readFileSync(cfg, "utf8");
    fs.writeFileSync(cfg, "{}");
    fs.writeFileSync(path.join(p.path, ".mcp.json"), JSON.stringify({ mcpServers: { "component-library": {} } }));
    expect((await lib.claudeCode.check(p.id)).mcp.where).toBe("project");
    expect(written).toBe(JSON.stringify({ mcpServers: { "component-library": { command: "x" } } })); // only read
  });
});
