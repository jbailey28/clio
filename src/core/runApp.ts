import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { dataDir, type DB } from "./db";
import { invalid } from "./errors";
import { checkPath } from "./paths";
import { getProject } from "./projects";

/**
 * "Run": starts a recorded project's app on this Mac so it can be opened in a
 * browser, and stops it again. Four rules, each enforced here:
 *
 * 1. No shell. The program is started directly with its arguments as a list
 *    (spawn, shell: false). A folder name is only ever the working folder, so
 *    nothing in it can become a command.
 * 2. Only known commands. A project picks one of RUN_PRESETS; there is nowhere
 *    to type a command. The program comes from the folder of the Node running
 *    this library, never from the project.
 * 3. Approved once. The first run of a preset needs the person's approval of
 *    the exact command; changing the preset needs approval again.
 * 4. Stop ends only what Run started: a process this library recorded that is
 *    still its own group leader, running the same command, and started at the
 *    same moment as recorded. Anything else is forgotten, never signalled.
 */

/** What a project's package.json says it has. Read only, and only to decide which presets fit. */
interface Pkg { deps: Record<string, unknown>; scripts: Record<string, unknown> }

/**
 * The built-in commands. `fits` says whether the project has what the command
 * needs; a preset that doesn't fit is never offered or run. npx always gets
 * "--no", so it only uses what the project already has and never downloads.
 */
export const RUN_PRESETS = {
  "expo-web": { label: "Expo web preview", program: "npx", npxNoInstall: true, args: (port: number) => ["expo", "start", "--web", "--port", String(port)], fits: (p: Pkg) => "expo" in p.deps, needs: "expo in its dependencies" },
  "npm-dev": { label: "npm run dev", program: "npm", npxNoInstall: false, args: (_port: number) => ["run", "dev"], fits: (p: Pkg) => typeof p.scripts.dev === "string", needs: "a \"dev\" script" },
  "next-dev": { label: "Next.js dev server", program: "npx", npxNoInstall: true, args: (port: number) => ["next", "dev", "-p", String(port)], fits: (p: Pkg) => "next" in p.deps, needs: "next in its dependencies" },
} as const;

/** The full argument list given to the program: npx always first gets --no (never install). */
const fullArgs = (preset: RunPreset, port: number): string[] =>
  RUN_PRESETS[preset].npxNoInstall ? ["--no", ...RUN_PRESETS[preset].args(port)] : [...RUN_PRESETS[preset].args(port)];

function readPkg(folder: string): Pkg {
  try {
    const file = path.join(folder, "package.json");
    if (fs.statSync(file).size > 1024 * 1024) return { deps: {}, scripts: {} };
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
    return { deps: { ...obj(j.dependencies), ...obj(j.devDependencies) }, scripts: obj(j.scripts) };
  } catch {
    return { deps: {}, scripts: {} };
  }
}
export type RunPreset = keyof typeof RUN_PRESETS;
export const isRunPreset = (s: string): s is RunPreset => Object.prototype.hasOwnProperty.call(RUN_PRESETS, s);

/** Addresses Run may use, first free one wins. */
export const RUN_PORTS = [8090, 8091, 8092, 8093, 8094, 8095, 8096, 8097, 8098, 8099];

interface Running {
  pid: number; port: number; preset: RunPreset; startedAt: string; signature: string;
  /** The process's own start time as ps reports it. A reused process number always has a different one. */
  processStart: string;
}

export interface RunStatus {
  project: { id: string; name: string; path: string };
  folder: { ok: boolean; problem: string | null };
  preset: RunPreset | null;
  presets: { id: RunPreset; label: string }[];
  approved: boolean;
  /** The exact command, shown before approval. Port shown as the first one Run would try. */
  command: string | null;
  /** ready: the address answers. Until then it's still starting. */
  running: { port: number; url: string; startedAt: string; ready: boolean } | null;
  /** Why the last run ended on its own, from the end of its output. Cleared on the next Run. */
  ended: string | null;
}

/** Where the programs come from: the Node this library runs on (or a stand-in folder in tests). */
function programPath(name: string): string {
  const dir = process.env.COMPONENT_LIBRARY_RUN_BIN_DIR || path.dirname(process.execPath);
  return path.join(dir, name);
}

const runsFile = () => path.join(dataDir(), "runs.json");
const endedFile = () => path.join(dataDir(), "run-ended.json");
function readEnded(): Record<string, string> { try { return JSON.parse(fs.readFileSync(endedFile(), "utf8")); } catch { return {}; } }
function setEnded(projectId: string, note: string | null) {
  const all = readEnded();
  if (note) all[projectId] = note; else delete all[projectId];
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(endedFile(), JSON.stringify(all, null, 2));
}

/** The most useful last line of a run's output: the last error if there is one, else the last line. */
function lastLine(projectId: string): string {
  try {
    const lines = fs.readFileSync(path.join(dataDir(), "run-logs", `${projectId}.log`), "utf8")
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
    // Expo's own words when a copy is already running elsewhere.
    if (lines.some((l) => /Skipping dev server/i.test(l))) return "This project is already running somewhere else, so Expo didn't start a second copy.";
    const err = [...lines].reverse().find((l) => /error|cannot|couldn't|not found|missing|failed|canceled/i.test(l));
    return (err ?? lines.at(-1) ?? "It stopped without saying why.").slice(0, 300);
  } catch {
    return "It stopped without saying why.";
  }
}
const logFile = (projectId: string) => path.join(dataDir(), "run-logs", `${projectId}.log`);

function readRuns(): Record<string, Running> {
  try { return JSON.parse(fs.readFileSync(runsFile(), "utf8")); } catch { return {}; }
}
function writeRuns(runs: Record<string, Running>) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(runsFile(), JSON.stringify(runs, null, 2));
}

/** What the recorded process must still be running for Stop to touch it. */
const signatureOf = (preset: RunPreset, port: number) => RUN_PRESETS[preset].args(port).join(" ");

/** A live process's group and command line, or null if there is none. ps gets the pid as an argument, no shell. */
function processOf(pid: number): Promise<{ pgid: number; command: string } | null> {
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-o", "pgid=,command=", "-p", String(pid)], { timeout: 5000 }, (err, out) => {
      const m = err ? null : /^\s*(\d+)\s+(.*)$/s.exec(out.trim());
      resolve(m ? { pgid: Number(m[1]), command: m[2] } : null);
    });
  });
}

/** When a process started, as ps reports it ("lstart"), or null if there is no such process. No shell. */
function processStartOf(pid: number): string | null {
  try { return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 }).trim() || null; } catch { return null; }
}

/** The recorded run, only if that process is alive AND still running the command Run started. */
async function liveRun(projectId: string): Promise<Running | null> {
  const runs = readRuns();
  const r = runs[projectId];
  if (!r) return null;
  // Run starts the program as the leader of its own group, running exactly its command. Both must still hold.
  // ...and it must be the same process, started at the moment Run recorded, not a later one given the same number.
  const live = await processOf(r.pid);
  if (live && live.pgid === r.pid && live.command.includes(r.signature) && !!r.processStart && processStartOf(r.pid) === r.processStart) return r;
  if (!live) setEnded(projectId, lastLine(projectId)); // it ended on its own: say why, from its output
  delete runs[projectId]; // gone, or the number now belongs to something else: forget it, never signal it
  writeRuns(runs);
  return null;
}

/** Runs a program directly (no shell) and gives back what it printed, or "" if it failed. */
function readOut(program: string, args: string[]): Promise<string> {
  return new Promise((resolve) => execFile(program, args, { timeout: 10_000, maxBuffer: 4 << 20 }, (err, out) => resolve(err && !out ? "" : String(out))));
}

/**
 * Something already serving this project's folder that Run didn't start (for
 * example the project started by hand in Terminal): the address it answers on,
 * or null. Read-only: lsof lists listening programs and their working folders.
 */
async function servedElsewhere(folder: string): Promise<number | null> {
  const listening = await readOut("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]);
  const ports = new Map<number, number>(); // pid -> first port
  let pid = 0;
  for (const line of listening.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid && !ports.has(pid)) {
      const port = Number(line.slice(line.lastIndexOf(":") + 1));
      if (port) ports.set(pid, port);
    }
  }
  if (!ports.size) return null;
  const cwds = await readOut("/usr/sbin/lsof", ["-a", "-d", "cwd", "-Fpn", "-p", [...ports.keys()].join(",")]);
  const real = fs.realpathSync(folder);
  pid = 0;
  for (const line of cwds.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) {
      const cwd = line.slice(1);
      if (cwd === real || cwd.startsWith(real + path.sep)) return ports.get(pid) ?? null;
    }
  }
  return null;
}

/** Whether something answers on this address yet. */
function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    sock.setTimeout(1000);
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => resolve(false));
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
  });
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

function projectRow(db: DB, ref: string) {
  const p = getProject(db, ref); // only projects recorded in the library
  const row = db.prepare("SELECT run_preset AS preset, run_approved AS approved FROM projects WHERE id = ?").get(p.id) as { preset: string; approved: string };
  const pkg = readPkg(p.path);
  // A stored preset that no longer fits the project counts as none chosen.
  const preset = isRunPreset(row.preset) && RUN_PRESETS[row.preset].fits(pkg) ? row.preset : null;
  return { p, pkg, preset, approved: !!preset && row.approved === preset };
}

function folderCheck(db: DB, folder: string) {
  try {
    if (!fs.existsSync(folder)) throw new Error(`The saved location can't be found: ${folder}.`);
    if (!fs.statSync(folder).isDirectory()) throw new Error(`The saved location isn't a folder: ${folder}.`);
    checkPath(db, folder, "directory"); // still inside the allowed folders
    return { ok: true, problem: null };
  } catch (err) {
    return { ok: false, problem: (err as Error).message };
  }
}

export async function runStatus(db: DB, ref: string): Promise<RunStatus> {
  const { p, pkg, preset, approved } = projectRow(db, ref);
  const r = await liveRun(p.id);
  return {
    project: { id: p.id, name: p.name, path: p.path },
    folder: folderCheck(db, p.path),
    preset,
    // Only the commands this project can actually run.
    presets: (Object.keys(RUN_PRESETS) as RunPreset[]).filter((id) => RUN_PRESETS[id].fits(pkg)).map((id) => ({ id, label: RUN_PRESETS[id].label })),
    approved,
    command: preset ? [RUN_PRESETS[preset].program, ...fullArgs(preset, RUN_PORTS[0])].join(" ") : null,
    running: r ? { port: r.port, url: `http://localhost:${r.port}`, startedAt: r.startedAt, ready: await answers(r.port) } : null,
    ended: r ? null : readEnded()[p.id] ?? null,
  };
}

/** Choosing a preset (or a different one) always clears the approval. */
export function setRunPreset(db: DB, ref: string, preset: string) {
  if (!isRunPreset(preset)) throw invalid(`Unknown run command. Choose one of: ${Object.values(RUN_PRESETS).map((x) => x.label).join(", ")}.`);
  const p = getProject(db, ref);
  if (!RUN_PRESETS[preset].fits(readPkg(p.path))) throw invalid(`${RUN_PRESETS[preset].label} doesn't fit this project: it needs ${RUN_PRESETS[preset].needs} in package.json.`);
  db.prepare("UPDATE projects SET run_preset = ?, run_approved = '' WHERE id = ?").run(preset, p.id);
}

/** Records approval of the project's current preset. Approval names the preset, so it can't carry over to another. */
export function approveRun(db: DB, ref: string) {
  const { p, preset } = projectRow(db, ref);
  if (!preset) throw invalid("Choose how this project runs first.");
  db.prepare("UPDATE projects SET run_approved = ? WHERE id = ?").run(preset, p.id);
}

export async function startRun(db: DB, ref: string): Promise<RunStatus> {
  const { p, preset, approved } = projectRow(db, ref);
  if (!preset) throw invalid("Choose how this project runs first.");
  if (!approved) throw invalid("Approve the run command first.");
  const folder = folderCheck(db, p.path);
  if (!folder.ok) throw invalid(folder.problem!);
  if (await liveRun(p.id)) throw invalid("It's already running.");
  const elsewhere = await servedElsewhere(p.path);
  if (elsewhere) throw invalid(`This project is already running at localhost:${elsewhere}, started outside Run. Stop that one first, then press Run.`);

  const program = programPath(RUN_PRESETS[preset].program);
  if (!fs.existsSync(program)) throw invalid(`Can't find ${RUN_PRESETS[preset].program} next to this library's Node (${path.dirname(program)}).`);

  let port = 0;
  for (const candidate of RUN_PORTS) if (await portFree(candidate)) { port = candidate; break; }
  if (!port) throw invalid(`No free address between localhost:${RUN_PORTS[0]} and ${RUN_PORTS.at(-1)}. Stop something first.`);

  const args = fullArgs(preset, port);
  setEnded(p.id, null);
  fs.mkdirSync(path.dirname(logFile(p.id)), { recursive: true });
  const log = fs.openSync(logFile(p.id), "w");
  const child = spawn(program, args, {
    cwd: fs.realpathSync(p.path),
    shell: false, // rule 1: never a shell
    detached: true, // its own process group, so Stop ends everything it started
    stdio: ["ignore", log, log],
    env: { ...process.env, PORT: String(port), BROWSER: "none", PATH: `${path.dirname(program)}:${process.env.PATH ?? ""}` },
  });
  fs.closeSync(log);
  if (!child.pid) throw invalid("It didn't start.");
  child.unref();
  const processStart = processStartOf(child.pid);
  if (!processStart) throw invalid("It didn't start.");

  const runs = readRuns();
  runs[p.id] = { pid: child.pid, port, preset, startedAt: new Date().toISOString(), signature: signatureOf(preset, port), processStart };
  writeRuns(runs);

  // Wait until it answers, or until it ends on its own: never report "running" for something that already stopped.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await answers(port)) break;
    if (!(await liveRun(p.id))) throw invalid(`It stopped right away: ${readEnded()[p.id] ?? "no reason given."}`);
    await new Promise((res) => setTimeout(res, 500));
  }
  return runStatus(db, p.id);
}

/** Ends only a run this library started and that is still running its command. */
export async function stopRun(db: DB, ref: string): Promise<RunStatus> {
  const p = getProject(db, ref);
  const r = await liveRun(p.id);
  if (r) {
    try { process.kill(-r.pid, "SIGTERM"); } catch { /* already ended */ }
    const runs = readRuns();
    delete runs[p.id];
    writeRuns(runs);
  }
  return runStatus(db, p.id);
}
