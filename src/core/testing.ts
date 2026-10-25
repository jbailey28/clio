import { spawn } from "node:child_process";
import path from "node:path";
import type { DB } from "./db";
import { LibraryError } from "./errors";
import { checkPath } from "./paths";
import { getSettings } from "./settings";
import { getComponent, recordActivity, type TestStatus } from "./components";
import { newId, now } from "./util";

export interface TestRun {
  id: string;
  componentId: string;
  command: string;
  cwd: string;
  status: TestStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
}

const MAX_OUTPUT = 200_000;

export function listTestRuns(db: DB, componentRef: string, limit = 20): TestRun[] {
  const c = getComponent(db, componentRef);
  return db
    .prepare(`SELECT id, component_id AS componentId, command, cwd, status, exit_code AS exitCode, stdout, stderr,
                     duration_ms AS durationMs, started_at AS startedAt, finished_at AS finishedAt
              FROM test_runs WHERE component_id = ? ORDER BY started_at DESC LIMIT ?`)
    .all(c.id, Math.min(limit, 200)) as TestRun[];
}

/** Where the test command runs: the explicit test folder, else the primary source folder (or the folder holding the primary file). */
export function resolveTestCwd(db: DB, componentRef: string): string {
  const c = getComponent(db, componentRef);
  if (c.testCwd) return checkPath(db, c.testCwd, "directory").path;
  const primary = c.sources.find((s) => s.isPrimary) ?? c.sources[0];
  if (!primary) throw new LibraryError("TEST_NOT_CONFIGURED", "This component has no source path to run tests in.");
  const checked = checkPath(db, primary.path);
  return checked.kind === "directory" ? checked.path : path.dirname(checked.path);
}

export interface ShellResult { status: TestStatus; exitCode: number | null; stdout: string; stderr: string }

/**
 * Runs one shell command in a folder with a time limit and returns exactly
 * what happened. Used for registered components and for staged drafts.
 */
export function runShell(command: string, cwd: string, timeoutMs: number, env: Record<string, string> = {}): Promise<ShellResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (cur: string, chunk: Buffer) => (cur.length >= MAX_OUTPUT ? cur : (cur + chunk.toString("utf8")).slice(0, MAX_OUTPUT));

    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0", ...env },
      detached: true, // own process group, so a timeout can stop everything it started
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout = append(stdout, d)));
    child.stderr.on("data", (d: Buffer) => (stderr = append(stderr, d)));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: "error", exitCode: null, stdout, stderr: `${stderr}\nCould not start the command: ${err.message}`.trim() });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut)
        resolve({ status: "timeout", exitCode: code, stdout, stderr: `${stderr}\nStopped after ${timeoutMs / 1000}s (the timeout in Settings).`.trim() });
      else resolve({ status: code === 0 ? "passed" : "failed", exitCode: code, stdout, stderr });
    });
  });
}

/**
 * Runs the component's configured test command for real and stores exactly
 * what happened. Nothing here guesses: no command means no run, not a failure.
 */
export async function runComponentTests(db: DB, componentRef: string): Promise<TestRun> {
  const c = getComponent(db, componentRef);
  if (!c.testCommand.trim())
    throw new LibraryError("TEST_NOT_CONFIGURED", `"${c.name}" has no test command. Add one under Configuration.`);
  const cwd = resolveTestCwd(db, c.id);
  const timeoutMs = getSettings(db).testTimeoutSeconds * 1000;

  const startedAt = now();
  const t0 = Date.now();
  const result = await runShell(c.testCommand, cwd, timeoutMs);

  const run: TestRun = {
    id: newId("run"),
    componentId: c.id,
    command: c.testCommand,
    cwd,
    ...result,
    durationMs: Date.now() - t0,
    startedAt,
    finishedAt: now(),
  };
  db.transaction(() => {
    db.prepare(`INSERT INTO test_runs (id, component_id, command, cwd, status, exit_code, stdout, stderr, duration_ms, started_at, finished_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(run.id, run.componentId, run.command, run.cwd, run.status, run.exitCode, run.stdout, run.stderr, run.durationMs, run.startedAt, run.finishedAt);
    recordActivity(db, c.id, `tests ${run.status}`);
  })();
  return run;
}
