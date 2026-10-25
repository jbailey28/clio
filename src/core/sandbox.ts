import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDir } from "./db";

/**
 * The macOS sandbox that generated components' tests run in. Inside it, code
 * can read its own folder, read and write a throwaway temp folder, and use the
 * system's Python. It cannot use the network, write anywhere else, or read
 * anything else in your home folder.
 */
export const PYTHON = "/usr/bin/python3";

const PROFILE = `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write* (subpath (param "TMP")) (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))
(deny file-read* (subpath (param "HOME_DIR")))
(allow file-read* (subpath (param "DIR")) (subpath (param "TMP")))
(allow file-read-metadata)
`;

/** Writes the sandbox profile if it is missing or out of date, and returns its path. */
export function ensureSandboxProfile(): string {
  const file = path.join(dataDir(), "sandbox", "python-tests.sb");
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== PROFILE) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, PROFILE);
  }
  return file;
}

/**
 * The test command stored on a generated component. It runs Python's built-in
 * test runner on tests/test_*.py inside the sandbox, with a fresh temp folder
 * that is removed afterwards.
 */
export function sandboxedPythonTestCommand(): string {
  const profile = ensureSandboxProfile();
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    // Real paths: the sandbox matches /private/var/..., not the /var/... alias mktemp prints.
    `T=$(cd "$(mktemp -d)" && pwd -P) && D=$(pwd -P) &&`,
    `/usr/bin/sandbox-exec -f ${q(profile)} -D DIR="$D" -D TMP="$T" -D HOME_DIR=${q(fs.realpathSync(os.homedir()))}`,
    `/usr/bin/env PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=. TMPDIR="$T" HOME="$T"`,
    `${PYTHON} -m unittest discover -s tests -p 'test_*.py' -v;`,
    `r=$?; rm -rf "$T"; exit $r`,
  ].join(" ");
}

/**
 * Runs a project's tests (tests/test_*.py) in the sandbox and records which
 * functions of its copied components (components/<slug>/...) were entered
 * from outside the component. The runner is written to the temp folder, so
 * nothing is added to the project. Its last line of output is
 * "COMPONENT-CALLS: {slug: [function, ...]}".
 */
const TRACE_RUNNER = `import json, os, sys, threading, unittest
root = os.path.realpath(os.getcwd())
comp = os.path.join(root, "components") + os.sep
seen, real = {}, {}
def where(f):
    if f not in real: real[f] = os.path.realpath(f) if f and not f.startswith("<") else ""
    return real[f]
def prof(frame, event, arg):
    if event != "call": return
    f = where(frame.f_code.co_filename)
    if not f.startswith(comp): return
    back = frame.f_back
    if back is not None and where(back.f_code.co_filename).startswith(comp): return
    if frame.f_code.co_name.startswith("<"): return  # importing a module is not calling it
    seen.setdefault(f[len(comp):].split(os.sep)[0], set()).add(frame.f_code.co_name)
sys.path.insert(0, root)
sys.setprofile(prof); threading.setprofile(prof)
suite = unittest.defaultTestLoader.discover("tests", pattern="test_*.py") if os.path.isdir("tests") else unittest.TestSuite()
result = unittest.TextTestRunner(verbosity=2).run(suite)
sys.setprofile(None)
print("COMPONENT-CALLS: " + json.dumps({k: sorted(v) for k, v in seen.items()}))
sys.exit(0 if result.wasSuccessful() and result.testsRun > 0 else 1)
`;

export function sandboxedTraceCommand(): string {
  const profile = ensureSandboxProfile();
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    `T=$(cd "$(mktemp -d)" && pwd -P) && D=$(pwd -P) &&`,
    `printf '%s' ${q(TRACE_RUNNER)} > "$T/run_tests.py" &&`,
    `/usr/bin/sandbox-exec -f ${q(profile)} -D DIR="$D" -D TMP="$T" -D HOME_DIR=${q(fs.realpathSync(os.homedir()))}`,
    `/usr/bin/env PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=. TMPDIR="$T" HOME="$T"`,
    `${PYTHON} "$T/run_tests.py";`,
    `r=$?; rm -rf "$T"; exit $r`,
  ].join(" ");
}

/** Reads the runner's report from test output. Missing (crashed before the end) = {}. */
export function componentCalls(output: string): Record<string, string[]> {
  const line = output.split("\n").reverse().find((l) => l.startsWith("COMPONENT-CALLS: "));
  try { return line ? JSON.parse(line.slice("COMPONENT-CALLS: ".length)) : {}; } catch { return {}; }
}

const STDLIB_CHECK = `import importlib.util, json, sys, sysconfig
std = sysconfig.get_paths()["stdlib"]
out = {}
for m in sys.argv[1:]:
    try: s = importlib.util.find_spec(m)
    except Exception: s = None
    out[m] = bool(s) and (s.origin in ("built-in", "frozen") or (s.origin or "").startswith(std)) and "site-packages" not in (s.origin or "")
print(json.dumps(out))`;

/** Which of these top-level module names are part of the system Python's standard library. Only looks them up; imports nothing. */
export function standardLibrary(names: string[]): Record<string, boolean> {
  if (!names.length) return {};
  return JSON.parse(execFileSync(PYTHON, ["-I", "-c", STDLIB_CHECK, ...names], { encoding: "utf8", timeout: 20_000 }));
}
