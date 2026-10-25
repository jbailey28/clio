import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DB } from "./db";
import { findClaude } from "./generator";
import { checkPath } from "./paths";
import { getProject } from "./projects";

/**
 * "Open in Claude Code": a new Terminal window in a recorded project's folder,
 * with an interactive Claude Code session started there. Nothing is typed into
 * Claude, nothing in the project runs, and no file is changed.
 *
 * Only a project id comes from the browser. The folder comes from the saved
 * project record (and must still be inside the allowed folders); the claude
 * program is the one this Mac already has. On macOS, Terminal is asked to run
 * the command through AppleScript, with the folder and program passed as
 * separate arguments and quoted by AppleScript itself ("quoted form of"), so
 * no path is ever pasted into a command unescaped. Elsewhere, and whenever the
 * launch fails, there is a copyable command instead.
 */

export type Platform = "macos" | "windows" | "linux" | "other";
export const platform = (): Platform => {
  const p = process.env.COMPONENT_LIBRARY_PLATFORM || process.platform; // tests can pretend to be another system
  return p === "darwin" ? "macos" : p === "win32" ? "windows" : p === "linux" ? "linux" : "other";
};

/** Shell quoting that is safe for any characters: wrap in single quotes, and write a ' as '\''. */
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The command to paste into a terminal, for this system. */
export function manualCommand(folder: string, on: Platform = platform()): string {
  if (on === "windows") return `cd /d "${folder}" && claude`; // Windows paths can't contain a double quote
  return `cd ${shellQuote(folder)} && claude`;
}

export interface OpenCheck {
  project: { id: string; name: string; path: string };
  folder: { ok: boolean; problem: string | null };
  cli: { found: boolean; path: string | null };
  /** loggedIn is null when it couldn't be checked. Only yes/no leaves the server: never the account details. */
  auth: { loggedIn: boolean | null; problem: string | null };
  mcp: { configured: boolean; where: "user" | "local" | "project" | null };
  platform: { name: Platform; canLaunch: boolean };
  command: string;
}

/** Whether Claude Code's own settings already list the Component Library MCP server (read only; nothing is changed). */
export function mcpConfigured(folder: string): OpenCheck["mcp"] {
  const isOurs = (name: string, cfg: any) => name === "component-library" || JSON.stringify(cfg ?? "").includes("component-library-mcp");
  const has = (servers: any) => !!servers && Object.entries(servers).some(([n, c]) => isOurs(n, c));
  const read = (f: string) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
  const config = read(process.env.COMPONENT_LIBRARY_CLAUDE_CONFIG || path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), ".claude.json"));
  if (has(config?.mcpServers)) return { configured: true, where: "user" };
  if (has(config?.projects?.[folder]?.mcpServers)) return { configured: true, where: "local" };
  if (has(read(path.join(folder, ".mcp.json"))?.mcpServers)) return { configured: true, where: "project" };
  return { configured: false, where: null };
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 1 << 20 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as any).code ?? null) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? (err as Error | null)?.message ?? "") }));
  });
}

/** Asks Claude Code whether it is signed in (`claude auth status --json`). Starts no session and sends nothing. */
async function signedIn(cli: string): Promise<OpenCheck["auth"]> {
  const r = await run(cli, ["auth", "status", "--json"], 15_000);
  try {
    const s = JSON.parse(r.stdout);
    if (typeof s.loggedIn === "boolean") return { loggedIn: s.loggedIn, problem: s.loggedIn ? null : "Claude Code isn't signed in. When it opens it will ask you to sign in, or run claude auth login in Terminal first." };
  } catch {}
  return { loggedIn: null, problem: "Couldn't check whether Claude Code is signed in. If it asks you to sign in when it opens, follow its steps." };
}

export async function checkOpen(db: DB, ref: string): Promise<OpenCheck> {
  const p = getProject(db, ref); // only projects recorded in the library
  const on = platform();
  const folder = { ok: true, problem: null as string | null };
  try {
    if (!fs.existsSync(p.path)) throw new Error(`The saved location can't be found: ${p.path}. If the project moved, update its folder path in Settings for this project.`);
    if (!fs.statSync(p.path).isDirectory()) throw new Error(`The saved location isn't a folder: ${p.path}.`);
    fs.accessSync(p.path, fs.constants.R_OK | fs.constants.X_OK);
    checkPath(db, p.path, "directory"); // still inside the allowed folders
  } catch (err) {
    folder.ok = false;
    folder.problem = (err as NodeJS.ErrnoException).code === "EACCES" ? `This app can't open ${p.path}: permission denied.` : (err as Error).message;
  }
  const cliPath = findClaude();
  return {
    project: { id: p.id, name: p.name, path: p.path },
    folder,
    cli: { found: !!cliPath, path: cliPath },
    auth: cliPath ? await signedIn(cliPath) : { loggedIn: null, problem: null },
    mcp: mcpConfigured(p.path),
    platform: { name: on, canLaunch: on === "macos" },
    command: manualCommand(p.path, on),
  };
}

// On macOS: ask Terminal to open a window and run "cd <folder> && <claude>". The two values arrive as
// arguments and are quoted by AppleScript, never pasted into the script text.
export const TERMINAL_SCRIPT = `on run argv
  set dir to item 1 of argv
  set cli to item 2 of argv
  tell application "Terminal"
    activate
    do script "cd " & quoted form of dir & " && " & quoted form of cli
  end tell
end run`;

const recent = new Map<string, number>();
const REPEAT_MS = 5000;

export type OpenResult = OpenCheck & {
  /** Terminal accepted the command. This doesn't prove Claude Code then started, or is signed in. */
  launched: boolean;
  /** Plain words for the person. */
  message: string;
  launchProblem: string | null;
};

export async function openInClaudeCode(db: DB, ref: string): Promise<OpenResult> {
  const c = await checkOpen(db, ref);
  const done = (launched: boolean, message: string, launchProblem: string | null = null): OpenResult => ({ ...c, launched, message, launchProblem });
  if (!c.folder.ok) return done(false, c.folder.problem!);
  if (!c.cli.found) return done(false, "Claude Code isn't installed on this Mac, so it can't be opened. Install it from claude.com/claude-code, then try again.");
  if (!c.platform.canLaunch) return done(false, "Opening a terminal automatically only works on macOS. Copy this command into a terminal instead.");
  const last = recent.get(c.project.id);
  if (last && Date.now() - last < REPEAT_MS) return done(false, "It was opened a moment ago. Look for the Terminal window that's already open.", "repeat");
  recent.set(c.project.id, Date.now());
  const launcher = process.env.COMPONENT_LIBRARY_TERMINAL_LAUNCHER; // tests: a stand-in that gets the same two arguments
  const r = launcher ? await run(launcher, [c.project.path, c.cli.path!], 60_000) : await run("/usr/bin/osascript", ["-e", TERMINAL_SCRIPT, c.project.path, c.cli.path!], 60_000);
  if (r.code !== 0) {
    recent.delete(c.project.id);
    const denied = /-1743|not authori[sz]ed|not allowed/i.test(r.stderr);
    return done(false, denied
      ? "macOS didn't allow this app to control Terminal. Allow it in System Settings → Privacy & Security → Automation, or copy this command into Terminal."
      : "Terminal couldn't be opened automatically. Copy this command into Terminal instead.", r.stderr.trim().slice(0, 300) || `exit ${r.code}`);
  }
  return done(true, c.auth.loggedIn === false
    ? "Terminal opened in the project folder and started Claude Code. It isn't signed in yet, so it will ask you to sign in first."
    : c.auth.loggedIn === true
      ? "Terminal opened in the project folder and started Claude Code. Look for the new Terminal window."
      : "Terminal opened in the project folder and started Claude Code. Sign-in couldn't be checked, so it may ask you to sign in.");
}
