// A stand-in for Claude Code in tests: reads {task, prompt, schema} on stdin, prints a JSON answer.
// Markers in the description choose what goes wrong:
//   [fail-propose] [fail-generate] [questions] [needs-package] [new-category] [cat:<slug>] [name:<Name>]
//   [bad-path] [secret] [third-party] [failing-tests] (fixed on the next attempt) [marker] (writes a file when imported) [slow] (3 s per answer)
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { task, prompt } = JSON.parse(input);
const has = (m) => prompt.includes(m);
if (has("[slow]")) await new Promise((r) => setTimeout(r, 3000)); // time to watch progress
const out = (v) => process.stdout.write(JSON.stringify(v));

if (task === "propose" && prompt.startsWith("Plan a new, small local software project")) {
  // Project plans. Markers in the description: [fail-project] [vague] (open-ended: a starter project)
  const description = prompt.split('"""')[1] ?? "";
  const mark = (m) => description.includes(m);
  if (mark("[fail-project]")) { process.stderr.write("model overloaded"); process.exit(1); }
  if (mark("[vague]")) {
    out({ name: "Idea Notebook", description: "Keeps short notes about ideas on a page.", summary: "A small starter: you add ideas, it keeps them in a list you can read.",
      technology: "A Python tool that writes a web page", openEnded: true,
      features: [{ text: "Add an idea with a title", origin: "asked" }, { text: "Show every idea on one page", origin: "suggested" }] });
    process.exit(0);
  }
  out({ name: "Weekly Dashboard", description: "Shows last week's numbers on a page.", summary: "It reads your Instagram export, works out the week's numbers and shows them on a page.",
    technology: "A Python 3 tool that writes a web page", openEnded: false,
    features: [
      { text: "Read your weekly Instagram export", origin: "asked" },
      { text: "Work out the weekly numbers", origin: "asked" },
      { text: "Show them on a dashboard page", origin: "asked" },
      { text: "Email a summary every Monday", origin: "suggested" },
    ] });
  process.exit(0);
}

if (task === "propose" && prompt.startsWith("Change a project plan the way the person asks.")) {
  // Refinements. Markers in the instruction: [rename:<Name>] [add:<text>] [remove:<word>] [reword:<word>=<text>] [noop] [fail-refine]
  const instruction = prompt.split('"""')[1] ?? "";
  if (instruction.includes("[fail-refine]")) { process.stderr.write("model overloaded"); process.exit(1); }
  const feats = [...prompt.matchAll(/^(f_[a-z0-9]+): (.+?) \[/gm)].map((m) => ({ id: m[1], text: m[2] }));
  const all = (re) => [...instruction.matchAll(re)].map((m) => m[1]);
  const find = (word) => feats.find((f) => f.text.toLowerCase().includes(word.toLowerCase()));
  out({
    note: "Changed what you asked.",
    name: instruction.match(/\[rename:([^\]]+)\]/)?.[1] ?? null, description: null, summary: null, technology: instruction.match(/\[tech:([^\]]+)\]/)?.[1] ?? null,
    add: all(/\[add:([^\]]+)\]/g).map((text) => ({ text })),
    update: all(/\[reword:([^\]]+)\]/g).map((x) => { const [w, text] = x.split("="); return { id: find(w)?.id ?? "f_unknown", text }; }),
    remove: all(/\[remove:([^\]]+)\]/g).map((w) => find(w)?.id).filter(Boolean),
  });
  process.exit(0);
}

if (task === "propose" && prompt.startsWith("Work out what this project needs")) {
  // Component analysis. Markers in the first description: [use:<slug>,...] [fn:<name>] (claim it calls this) [ghost] (name a component that doesn't exist) [fail-analyze]
  const description = prompt.split('"""')[1] ?? "";
  const mark = (m) => description.includes(m);
  if (mark("[fail-analyze]")) { process.stderr.write("model overloaded"); process.exit(1); }
  const use = (description.match(/\[use:([^\]]+)\]/)?.[1] ?? "").split(",").filter(Boolean);
  const fn = description.match(/\[fn:([^\]]+)\]/)?.[1];
  const lines = prompt.split("\n");
  const realFns = (slug) => { const i = lines.findIndex((l) => l.startsWith(`- ${slug} (`)); return [...(lines[i + 1] ?? "").matchAll(/([A-Za-z_]\w*)\(/g)].map((m) => m[1]); };
  const feats = [...prompt.matchAll(/^(f_[a-z0-9]+): (.+)$/gm)].map((m) => ({ id: m[1], text: m[2] }));
  const needs = feats.map((f) => {
    const base = { need: f.text.replace(/^\w+ /, (w) => w), featureIds: [f.id], componentSlug: null, uses: [], contributes: "", limits: "", ifLeftOut: "", steps: "", why: `So it can ${f.text.toLowerCase()}.` };
    if (/numbers/i.test(f.text) && use.length) return { ...base, need: "Weekly numbers", status: "available", required: true, componentSlug: use[0], uses: fn ? [fn] : realFns(use[0]).slice(0, 1),
      contributes: `Works out the weekly numbers (${use[0]}).`, limits: "It doesn't collect anything from Instagram.", ifLeftOut: "A small function that adds up likes per week." };
    if (/email/i.test(f.text)) return { ...base, need: "Monday email", status: "setup", required: false, steps: "Create an app password for your email and set SMTP_PASSWORD." };
    return { ...base, need: f.text, status: "build", required: /read|show/i.test(f.text) };
  });
  for (const extra of use.slice(1)) needs.push({ need: `Extra from ${extra}`, featureIds: [], status: "partial", required: false, componentSlug: extra, uses: realFns(extra).slice(0, 1),
    contributes: `Helps a little (${extra}).`, limits: "Only part of it.", ifLeftOut: "Left to the project.", steps: "", why: "Optional extra." });
  if (mark("[ghost]")) needs.push({ need: "Imaginary", featureIds: [], status: "available", required: false, componentSlug: "imaginary-thing", uses: ["x"], contributes: "x", limits: "", ifLeftOut: "", steps: "", why: "x" });
  out({ language: "python", needs, connections: ["Instagram export (CSV)", "weekly numbers", "dashboard page"], compatibility: ["Screenshots need a browser engine; it writes a page instead."],
    files: [{ path: "README.md", purpose: "How to run it" }, { path: "app.py", purpose: "Builds the dashboard" }, { path: "tests/test_app.py", purpose: "Tests" }], nextSteps: ["Run python3 app.py"] });
  process.exit(0);
}

if (task === "generate" && prompt.startsWith("Write the files for this project.")) {
  // Markers in the original description: [no-call] [test-not-calling] [failing-tests] [bad-file] [secret] [clash]
  const description = prompt.split('"""')[1] ?? "";
  const mark = (m) => description.includes(m);
  const imports = [...prompt.matchAll(/^\s*from (\w+) import (\w+)/gm)].map((m) => ({ pkg: m[1], fn: m[2] }));
  const retry = prompt.includes("This is another attempt.");
  const files = [{ path: "README.md", content: "# Weekly Dashboard\n\nRun: python3 app.py\n" }];
  if (imports.length) {
    const head = ["import component_paths", ...imports.map((i) => `from ${i.pkg} import ${i.fn}`)].join("\n");
    const call = mark("[no-call]") && !retry ? "None" : `${imports[0].fn}(rows)`;
    files.push({ path: "app.py", content: `${head}\n\n\ndef build(rows):\n    stats = ${call}\n    return "<h1>Week</h1><p>%s</p>" % (stats,)\n\n\ndef unused():\n    return 1\n` });
    const body = mark("[test-not-calling]") && !retry ? "app.unused()" : "app.build([{'likes': '3'}, {'likes': '4'}])";
    const expect = mark("[failing-tests]") && !retry ? "'nope'" : "'<h1>'";
    files.push({ path: "tests/test_app.py", content: `import unittest\nimport app\n\n\nclass T(unittest.TestCase):\n    def test_build(self):\n        self.assertIn(${expect}, str(${body}) + '<h1>' * ${mark("[test-not-calling]") && !retry ? 1 : 0})\n` });
  } else {
    files.push({ path: "app.py", content: `def build(rows):\n    return "<h1>Week</h1><p>%d posts</p>" % len(rows)\n` });
    files.push({ path: "tests/test_app.py", content: `import unittest\nimport app\n\n\nclass T(unittest.TestCase):\n    def test_build(self):\n        self.assertIn("1 posts", app.build([{}]))\n` });
  }
  if (mark("[bad-file]")) files.push({ path: "../outside.txt", content: "x" });
  if (mark("[secret]")) files.push({ path: "config.py", content: 'API_KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345"\n' });
  // Passes every check, then fails while writing: notes.md is a file, so notes.md/extra.md can't be made.
  if (mark("[clash]")) files.push({ path: "notes.md", content: "x" }, { path: "notes.md/extra.md", content: "y" });
  out({ files });
  process.exit(0);
}

if (task === "propose") {
  const description = prompt.split('"""')[1] ?? ""; // judge the request itself, not every word in the prompt
  if (has("[fail-propose]")) { process.stderr.write("model overloaded"); process.exit(1); }
  const asking = has("[questions]") && !has("Their answers to your earlier questions");
  const cat = prompt.match(/\[cat:([a-z0-9-]+)\]/)?.[1] ?? null;
  out({
    name: prompt.match(/\[name:([^\]]+)\]/)?.[1] ?? "Email Cleaner",
    summary: "Cleans up a list of email addresses: trims them, lower-cases them and removes duplicates.",
    category: has("[new-category]") ? { slug: null, newName: "Text Tools", reason: "None of the existing categories is about text." }
      : { slug: cat, newName: null, reason: "It works on contact data." },
    inputs: [{ name: "addresses", type: "list of text", description: "The email addresses to clean" }],
    outputs: [{ name: "cleaned", type: "list of text", description: "Unique, cleaned addresses in their original order" }],
    approach: "Each address is trimmed and lower-cased, invalid ones are dropped, and repeats are removed.",
    capabilities: [{ name: "Email list cleanup", description: "Trim, lower-case, validate and dedupe email addresses" }],
    tests: "Checks trimming, lower-casing, dropping invalid addresses and keeping the original order.",
    needsPackages: has("[needs-package]") ? ["requests"] : [],
    questions: asking ? ["Should addresses without an @ be dropped or kept?"] : [],
    // Judges the shortlisted components it was shown: an email cleaner does this job, two email tools do part of it, the rest do not.
    existing: [...(prompt.split("Existing library components")[1] ?? "").split("Work out")[0].matchAll(/^- ([a-z0-9-]+): /gm)]
      .map((m) => m[1] === "email-cleaner"
        ? { slug: m[1], verdict: "same", covers: "It already cleans and dedupes email addresses.", missing: "" }
        : ["newsletter-sender", "lead-enrichment"].includes(m[1]) && /email/i.test(description)
          ? { slug: m[1], verdict: "partial", covers: "It works with email addresses.", missing: "It does not clean or dedupe them." }
          : { slug: m[1], verdict: "different", covers: "", missing: "It does a different job." }),
  });
  process.exit(0);
}

// generate
if (has("[fail-generate]")) { process.stdout.write("Sorry, I could not do that."); process.exit(0); }
const pkg = prompt.match(/- ([a-z0-9_]+)\/__init__\.py/)[1];
const retry = has("This is another attempt.");
let code = `"""Clean up email addresses."""
import re

_VALID = re.compile(r"^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$")


def clean(addresses):
    """Trimmed, lower-cased, valid, unique addresses in their original order."""
    seen, out = set(), []
    for a in addresses:
        a = str(a).strip().lower()
        if _VALID.match(a) and a not in seen:
            seen.add(a)
            out.append(a)
    return out
`;
if (has("[secret]")) code += `\nAPI_KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345"\n`;
if (has("[third-party]")) code = `import requests\n${code}`;
if (has("[marker]")) code = `import os\nopen(os.environ.get("CL_MARKER", "/dev/null"), "w").write("ran")\n${code}`;
const expectOrder = has("[failing-tests]") && !retry ? `["b@x.com", "a@x.com"]` : `["a@x.com", "b@x.com"]`;
const files = [
  { path: `${pkg}/__init__.py`, content: code },
  { path: `tests/test_${pkg}.py`, content: `import unittest
from ${pkg} import clean


class CleanTest(unittest.TestCase):
    def test_trims_lowercases_and_keeps_order(self):
        self.assertEqual(clean([" A@x.com", "b@X.com ", "a@x.com"]), ${expectOrder})

    def test_drops_invalid(self):
        self.assertEqual(clean(["nope", "x@y"]), [])


if __name__ == "__main__":
    unittest.main()
` },
  { path: "README.md", content: `# ${pkg}\n\nCleans a list of email addresses.\n` },
];
if (has("[bad-path]")) files.push({ path: "../escape.py", content: "print('escaped')" });
out({ files, usage: `from ${pkg} import clean\nclean([" A@x.com", "a@x.com"])  # ["a@x.com"]` });
