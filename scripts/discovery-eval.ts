/**
 * Prints discovery quality for the evaluation cases, in throwaway libraries.
 *
 *   npx tsx scripts/discovery-eval.ts           # summary
 *   npx tsx scripts/discovery-eval.ts --cases   # every case and what came back
 *
 * Never opens the real library.
 */
import { evaluate, summary, viaBrowser, viaFunctionality, type Score } from "../tests/discovery/evaluate";
import { makeLibrary, OVERLAPPING, WEBSITE_ANALYSIS } from "../tests/discovery/fixtures";

const verbose = process.argv.includes("--cases");

function show(title: string, s: Score) {
  console.log(`\n== ${title} (${s.cases} cases)\n${summary(s)}`);
  if (!verbose) return;
  for (const d of s.details) {
    const flag = d.falsePositive || d.wrongStrong || d.topCorrect === false ? "✗" : d.uncertain ? "?" : "✓";
    const hits = d.hits.slice(0, 3).map((h) => `${h.slug}${h.capability ? `[${h.capability}]` : ""}:${h.strength}`).join(", ");
    console.log(`  ${flag} [${d.c.kind}] ${d.c.q}\n      → ${hits || "(nothing)"}`);
  }
}

for (const [label, specs] of [
  ["Website Analysis + 5 overlapping fixtures", [WEBSITE_ANALYSIS, ...OVERLAPPING]],
  ["Website Analysis only (like the real library)", [WEBSITE_ANALYSIS]],
] as const) {
  const t = makeLibrary([...specs]);
  try {
    show(`${label} · find_reusable_functionality`, evaluate(t.lib, viaFunctionality));
    show(`${label} · browser search`, evaluate(t.lib, viaBrowser));
  } finally {
    t.close();
  }
}
