import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LibraryError } from "./errors";

/**
 * The AI that interprets descriptions and writes components: Claude Code on
 * this Mac (`claude -p`), using its existing sign-in, so no API key is kept by
 * the library or ever sent to the browser.
 *
 * It runs with no tools at all (it cannot read, write or run anything), no MCP
 * servers, none of your settings or instructions, in an empty folder. It can
 * only answer, in the JSON shape asked for. The library writes and checks the
 * files itself.
 *
 * COMPONENT_LIBRARY_GENERATOR replaces it with another command that reads
 * {task, prompt, schema} on stdin and prints the JSON answer (used by tests).
 */

export type Task = "propose" | "generate";

const MODEL = process.env.COMPONENT_LIBRARY_MODEL || "sonnet";
const LIMITS: Record<Task, { timeoutMs: number; budgetUsd: string }> = {
  propose: { timeoutMs: 3 * 60_000, budgetUsd: "1" },
  generate: { timeoutMs: 8 * 60_000, budgetUsd: "3" },
};

export function findClaude(): string | null {
  const executable = (c: string) => { try { fs.accessSync(c, fs.constants.X_OK); return fs.statSync(c).isFile(); } catch { return false; } };
  if (process.env.CLAUDE_CLI) return executable(process.env.CLAUDE_CLI) ? process.env.CLAUDE_CLI : null; // a path set on purpose is the only one used
  const candidates = [
    ...(process.env.PATH ?? "").split(":").map((d) => path.join(d, "claude")),
    "/opt/homebrew/bin/claude", "/usr/local/bin/claude", path.join(os.homedir(), ".local/bin/claude"), path.join(os.homedir(), ".claude/local/claude"),
  ].filter(Boolean) as string[];
  return candidates.find(executable) ?? null;
}

export function provider(): { name: string; detail: string; available: boolean } {
  if (process.env.COMPONENT_LIBRARY_GENERATOR) return { name: "Test generator", detail: process.env.COMPONENT_LIBRARY_GENERATOR, available: true };
  const cli = findClaude();
  return { name: "Claude Code", detail: cli ? `${cli} (model: ${MODEL}, no tools)` : "not found on this Mac", available: !!cli };
}

const fail = (message: string) => new LibraryError("GENERATION_FAILED", message);

/** Asks the AI for one structured answer. Throws GENERATION_FAILED with a readable reason. */
export async function ask<T>(task: Task, prompt: string, schema: object): Promise<T> {
  const { timeoutMs, budgetUsd } = LIMITS[task];
  const custom = process.env.COMPONENT_LIBRARY_GENERATOR;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cl-ai-")); // empty: there is nothing here for it to see
  try {
    if (custom) {
      const out = await run("/bin/sh", ["-c", custom], JSON.stringify({ task, prompt, schema }), cwd, timeoutMs);
      return parse<T>(out, "The test generator");
    }
    const cli = findClaude();
    if (!cli) throw fail("Claude Code was not found on this Mac, so nothing can be generated. Install it from claude.com/claude-code, or set CLAUDE_CLI to its path.");
    const out = await run(cli, [
      "-p", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--setting-sources", "",
      "--model", MODEL, "--max-budget-usd", budgetUsd, "--output-format", "json", "--json-schema", JSON.stringify(schema),
    ], prompt, cwd, timeoutMs);
    let reply: any;
    try { reply = JSON.parse(out); } catch { throw fail(`Claude Code answered in an unexpected format: ${out.slice(0, 300)}`); }
    if (reply.is_error) throw fail(`Claude Code reported a problem: ${String(reply.result ?? reply.subtype ?? "unknown").slice(0, 500)}`);
    if (!reply.structured_output) throw fail("Claude Code did not return the structured answer that was asked for. Try again.");
    return reply.structured_output as T;
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function parse<T>(out: string, who: string): T {
  try { return JSON.parse(out) as T; } catch { throw fail(`${who} answered with something that is not JSON: ${out.slice(0, 300)}`); }
}

function run(cmd: string, args: string[], stdin: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} reject(fail(`No answer after ${timeoutMs / 60000} minutes, so it was stopped. Try again.`)); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(fail(`Could not start the generator: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(fail(`The generator stopped with exit code ${code}. ${(err || out).trim().slice(0, 500)}`));
    });
    child.stdin.end(stdin);
  });
}
