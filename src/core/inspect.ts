import { execFileSync } from "node:child_process";
import type { DB } from "./db";
import { LibraryError } from "./errors";
import { getComponent } from "./components";
import { listReleases, verifyRelease } from "./releases";
import { PYTHON } from "./sandbox";

/**
 * What a component release actually contains, read from its code: its
 * packages, public functions (with signatures and the first line of their
 * docstrings), what it imports, and whether it touches the network, files,
 * other programs or environment variables. Uses Python's parser only: the
 * code is read, never imported or run.
 */

export interface ApiFunction { name: string; kind: "function" | "class"; signature: string; doc: string }
export interface ReleaseInspection {
  slug: string;
  name: string;
  version: string;
  releasePath: string;
  release: "intact" | "changed" | "missing";
  /** Python packages, each with the folder (relative to the release) that must be on sys.path to import it. */
  packages: { name: string; importRoot: string }[];
  api: ApiFunction[];
  imports: string[];
  usesNetwork: boolean;
  readsFiles: boolean;
  writesFiles: boolean;
  runsPrograms: boolean;
  envVars: string[];
  language: string;
  summary: string;
  capabilities: string[];
  inputs: string[];
  outputs: string[];
  lastTestStatus: string | null;
}

const SCRIPT = String.raw`
import ast, json, os, sys
root = sys.argv[1]
SKIP = {"tests", "test", "__pycache__", "bin", "docs"}
packages = []
for dirpath, dirnames, filenames in os.walk(root):
    rel = os.path.relpath(dirpath, root)
    depth = 0 if rel == "." else rel.count(os.sep) + 1
    dirnames[:] = [d for d in dirnames if d not in SKIP and not d.startswith(".")]
    if depth > 3: dirnames[:] = []
    if "__init__.py" in filenames and rel != "." and os.path.basename(dirpath) not in SKIP:
        parent = os.path.dirname(dirpath)
        if not os.path.exists(os.path.join(parent, "__init__.py")):  # top-level package only
            packages.append({"name": os.path.basename(dirpath), "importRoot": os.path.relpath(parent, root)})
def parse(path):
    try:
        with open(path, encoding="utf-8") as f: return ast.parse(f.read(), filename=path)
    except Exception: return None
def sig(node):
    if isinstance(node, ast.ClassDef):
        init = next((n for n in node.body if isinstance(n, ast.FunctionDef) and n.name == "__init__"), None)
        node = init or node
        if isinstance(node, ast.ClassDef): return "()"
    a = node.args
    names = [x.arg for x in a.posonlyargs + a.args]
    defaults = [None] * (len(names) - len(a.defaults)) + list(a.defaults)
    parts = []
    for n, d in zip(names, defaults):
        if n in ("self", "cls"): continue
        parts.append(n if d is None else n + "=" + (ast.unparse(d) if hasattr(ast, "unparse") else "..."))
    if a.vararg: parts.append("*" + a.vararg.arg)
    for k, d in zip(a.kwonlyargs, a.kw_defaults):
        parts.append(k.arg if d is None else k.arg + "=" + (ast.unparse(d) if hasattr(ast, "unparse") else "..."))
    if a.kwarg: parts.append("**" + a.kwarg.arg)
    return "(" + ", ".join(parts) + ")"
def doc(node):
    d = ast.get_docstring(node) or ""
    return d.strip().split("\n")[0][:200]
api, imports, env = [], set(), set()
flags = {"network": False, "reads": False, "writes": False, "programs": False}
NET = {"urllib", "http", "socket", "smtplib", "ftplib", "requests", "httpx", "aiohttp", "ssl", "imaplib", "poplib"}
for p in packages:
    pdir = os.path.join(root, p["importRoot"], p["name"])
    trees = {}
    for dp, dn, fn in os.walk(pdir):
        dn[:] = [d for d in dn if d not in SKIP]
        for f in fn:
            if f.endswith(".py"):
                t = parse(os.path.join(dp, f))
                if t: trees[os.path.relpath(os.path.join(dp, f), pdir)] = t
    for t in trees.values():
        for n in ast.walk(t):
            if isinstance(n, ast.Import):
                for a in n.names: imports.add(a.name.split(".")[0])
            elif isinstance(n, ast.ImportFrom) and n.level == 0 and n.module:
                imports.add(n.module.split(".")[0])
            elif isinstance(n, ast.Call):
                fn_ = n.func
                name = fn_.id if isinstance(fn_, ast.Name) else fn_.attr if isinstance(fn_, ast.Attribute) else ""
                if name == "open":
                    mode = n.args[1] if len(n.args) > 1 else next((k.value for k in n.keywords if k.arg == "mode"), None)
                    m = mode.value if isinstance(mode, ast.Constant) and isinstance(mode.value, str) else "r"
                    flags["writes" if any(c in m for c in "wax+") else "reads"] = True
                if name in ("system", "popen", "run", "Popen", "call", "check_output") and isinstance(fn_, ast.Attribute) and isinstance(fn_.value, ast.Name) and fn_.value.id in ("os", "subprocess"):
                    flags["programs"] = True
                if name in ("getenv", "get") and isinstance(fn_, ast.Attribute) and n.args and isinstance(n.args[0], ast.Constant) and isinstance(n.args[0].value, str):
                    if (isinstance(fn_.value, ast.Name) and fn_.value.id == "os") or (isinstance(fn_.value, ast.Attribute) and fn_.value.attr == "environ"):
                        env.add(n.args[0].value)
            elif isinstance(n, ast.Subscript) and isinstance(n.value, ast.Attribute) and n.value.attr == "environ":
                s = n.slice.value if hasattr(n.slice, "value") and not isinstance(n.slice, ast.Constant) else n.slice
                if isinstance(s, ast.Constant) and isinstance(s.value, str): env.add(s.value)
    if imports & NET: flags["network"] = True
    if "subprocess" in imports: flags["programs"] = True
    init = trees.get("__init__.py")
    defs = {}
    for rel, t in trees.items():
        for n in t.body:
            if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and not n.name.startswith("_"):
                defs.setdefault(n.name, n)
    public = None
    if init:
        for n in init.body:
            if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "__all__" for t in n.targets):
                try: public = [str(x) for x in ast.literal_eval(n.value)]
                except Exception: public = None
    if public is None:
        public = [n.name for n in (init.body if init else []) if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and not n.name.startswith("_")]
        if init:
            for n in init.body:
                if isinstance(n, ast.ImportFrom) and n.level >= 1:
                    public += [a.asname or a.name for a in n.names if not (a.asname or a.name).startswith("_")]
    for name in public:
        node = defs.get(name)
        if node is None: continue
        api.append({"name": name, "kind": "class" if isinstance(node, ast.ClassDef) else "function", "signature": sig(node), "doc": doc(node)})
local = {p["name"] for p in packages}
print(json.dumps({"packages": packages, "api": api, "imports": sorted(i for i in imports if i not in local), "flags": flags, "env": sorted(env)}))
`;

export function inspectRelease(db: DB, componentRef: string, version?: string): ReleaseInspection {
  const c = getComponent(db, componentRef);
  const releases = listReleases(db, c.id);
  const r = version ? releases.find((x) => x.version === version) : releases[0];
  if (!r) throw new LibraryError("NOT_FOUND", `"${c.name}" has no ${version ? `release ${version}` : "release"} to inspect.`);
  const check = verifyRelease(db, c.id, r.version);
  let read: any = { packages: [], api: [], imports: [], flags: {}, env: [] };
  if (check.state !== "missing") {
    try { read = JSON.parse(execFileSync(PYTHON, ["-I", "-c", SCRIPT, r.sourcePath], { encoding: "utf8", timeout: 30_000 })); }
    catch (err) { throw new LibraryError("VALIDATION", `Couldn't read the code of ${c.name} ${r.version}: ${(err as Error).message.slice(0, 300)}`); }
  }
  return {
    slug: c.slug, name: c.name, version: r.version, releasePath: r.sourcePath, release: check.state,
    packages: read.packages, api: read.api, imports: read.imports,
    usesNetwork: !!read.flags.network, readsFiles: !!read.flags.reads, writesFiles: !!read.flags.writes, runsPrograms: !!read.flags.programs, envVars: read.env,
    language: c.language, summary: c.summary,
    capabilities: c.capabilities.filter((x) => x.kind === "capability").map((x) => `${x.name}: ${x.description}`),
    inputs: c.inputs.map((i) => `${i.name} (${i.type}): ${i.description}`),
    outputs: c.outputs.map((o) => `${o.name} (${o.type}): ${o.description}`),
    lastTestStatus: c.lastTestStatus,
  };
}

/** Every component with a release, inspected; components whose code can't be read are skipped, with the reason. */
export function inspectAll(db: DB, slugs: string[]): { inspected: ReleaseInspection[]; skipped: { slug: string; reason: string }[] } {
  const inspected: ReleaseInspection[] = [];
  const skipped: { slug: string; reason: string }[] = [];
  for (const slug of slugs) {
    try { inspected.push(inspectRelease(db, slug)); } catch (err) { skipped.push({ slug, reason: (err as Error).message }); }
  }
  return { inspected, skipped };
}
