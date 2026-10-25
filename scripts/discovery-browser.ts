/**
 * Browser search, end to end: a production server on port 4411 over a
 * throwaway library (Website Analysis plus the overlapping fixtures), read
 * the way a browser reads it. Never opens the real library.
 *
 *   NEXT_DIST_DIR=.next-test npx next build
 *   NEXT_DIST_DIR=.next-test npx tsx scripts/discovery-browser.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { CASES } from "../tests/discovery/cases";
import { makeLibrary, OVERLAPPING, WEBSITE_ANALYSIS } from "../tests/discovery/fixtures";

const PORT = 4411;
const BASE = `http://127.0.0.1:${PORT}`;
const APP = path.resolve(import.meta.dirname, "..");
const t = makeLibrary([WEBSITE_ANALYSIS, ...OVERLAPPING]);
let server: ChildProcess | null = null;
let failures = 0;

const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${detail}` : ""}`);
  if (!ok) failures++;
};
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&")
  .replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const page = async (url: string) => { const r = await fetch(BASE + url); return { status: r.status, html: await r.text() }; };
const search = async (q: string) => text((await page(`/?q=${encodeURIComponent(q)}`)).html);
/** Component names in the order the results list shows them. */
const order = (html: string) => [...html.matchAll(/<li><a [^>]*href="\/components\/([a-z0-9-]+)"/g)].map((m) => m[1]);

async function main() {
  server = spawn(path.join(APP, "node_modules/.bin/next"), ["start", "-H", "127.0.0.1", "-p", String(PORT)], {
    cwd: APP,
    env: { ...process.env, COMPONENT_LIBRARY_HOME: path.join(t.dir, "db"), COMPONENT_LIBRARY_TRASH: path.join(t.dir, "Trash") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/help`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }

  const intercom = await search("I want to detect whether a company uses Intercom.");
  check("ordinary words find Website Analysis", intercom.includes("Website Analysis"));
  check("the matching capability is named", intercom.includes("Matching capability: Support chat detection"));
  check("the match is labelled strong", intercom.includes("strong match"));

  const reviewsHtml = (await page(`/?q=${encodeURIComponent("Analyze customer reviews.")}`)).html;
  const reviews = text(reviewsHtml);
  check("analyzing reviews puts Review Sentiment first", order(reviewsHtml)[0] === "review-sentiment", order(reviewsHtml).join(", "));
  check("Website Analysis is shown only as related, with the reason", /Website Analysis · Website Research related/.test(reviews) && reviews.includes("different job"));
  check("strong results come before related ones", reviews.indexOf("strong match") < reviews.indexOf(" related "));

  const none = await search("Create an authentication system.");
  check("an unrelated request says nothing fits", none.includes("Nothing in the library does this."));

  const typo = await search("detect ecomerce platfrom");
  check("misspellings are corrected and shown", typo.includes("Read as: ecomerce → ecommerce, platfrom → platform"));

  // The page ranks exactly as the service does, for every evaluation case.
  let same = 0;
  for (const c of CASES) {
    const html = (await page(`/?q=${encodeURIComponent(c.q)}`)).html;
    const expected = t.lib.discovery.browse(c.q).map((m) => m.component.slug);
    if (JSON.stringify(order(html)) === JSON.stringify(expected)) same++;
    else console.log(`      differs: ${c.q}: page ${order(html).join(",")} vs ${expected.join(",")}`);
  }
  check(`the page shows the service's ranking for all ${CASES.length} cases`, same === CASES.length, `${same}/${CASES.length}`);

  // Browsing still works as before.
  check("home page", (await page("/")).status === 200);
  const cat = await page("/categories/website-research");
  check("category page lists its components", cat.status === 200 && cat.html.includes("Website Analysis") && cat.html.includes("Tech Stack Scanner"));
  check("component page", (await page("/components/website-analysis")).status === 200);
  check("categories search still filters categories", text((await page("/?q=networking")).html).includes("Categories matching"));
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(async () => {
    if (server) await new Promise<void>((resolve) => { server!.once("exit", () => resolve()); server!.kill("SIGTERM"); });
    t.close();
    console.log(failures ? `\n${failures} FAILED` : "\nall browser checks passed");
    process.exit(failures ? 1 : 0);
  });
