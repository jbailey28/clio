/**
 * The interface, driven the way a person uses it: a real Chrome (headless,
 * through its DevTools protocol) clicking, typing and pressing keys against a
 * production server on its own port and a throwaway library. Never opens the
 * real library.
 *
 *   NEXT_DIST_DIR=.next-test npx next build
 *   NEXT_DIST_DIR=.next-test npx tsx scripts/ui-browser.ts [--shots <folder>]
 *
 * CHROME overrides the browser path.
 */
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeLibrary, OVERLAPPING, WEBSITE_ANALYSIS } from "../tests/discovery/fixtures";
import { unlockTree } from "../src/core/releases";

const PORT = 4412;
const DEBUG_PORT = 9333;
const BASE = `http://127.0.0.1:${PORT}`;
const APP = path.resolve(import.meta.dirname, "..");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const shotsAt = process.argv.indexOf("--shots");
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;

// ---------- a throwaway library with enough data to exercise every control ----------
const t = makeLibrary([WEBSITE_ANALYSIS, ...OVERLAPPING]);
for (const [name, description] of [
  ["Data Handling", "Import, clean, and validate data."], ["Integrations", "Connect to external services and APIs."],
  ["Utilities", "Common helper functions."], ["Workflow", "Automation and orchestration tools."],
]) t.lib.categories.create({ name, description });
const categoryCount = t.lib.categories.list().length;
t.lib.settings.update({ projectsRoot: path.join(t.dir, "Projects") });
for (const [rel, text] of [["code/shop-site/package.json", JSON.stringify({ name: "shop-site", description: "The shop's website." })], ["code/mailer/README.md", "# Mailer\n\nSorts incoming mail.\n"]]) {
  fs.mkdirSync(path.dirname(path.join(t.dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(t.dir, rel), text);
}
fs.mkdirSync(path.join(t.dir, "Projects", "taken"), { recursive: true });
const projectDir = path.join(t.dir, "invoice-app");
fs.mkdirSync(projectDir);
const project = t.lib.projects.register({ path: projectDir, name: "Invoice app", description: "Billing and contact imports" });
t.lib.projects.register({ path: fs.mkdtempSync(path.join(t.dir, "p-")), name: "Archive tool" });
const wa = t.lib.components.search("Website Analysis")[0];
t.lib.components.update(wa.id, { testCommand: "echo all good" });
t.lib.projects.link(project.id, wa.id, "Used for account research");
t.lib.components.markViewed(wa.id);

let server: ChildProcess | null = null;
let chrome: ChildProcess | null = null;
let failures = 0;
let draftUrl = "";
const stepPages: string[] = [];
const trashDir = path.join(t.dir, "Trash"); // the test server's Trash: never the real one
const aiLog = path.join(t.dir, "ai-calls.log");
/** How many AI requests the server has made so far. */
const aiCalls = () => (fs.existsSync(aiLog) ? fs.readFileSync(aiLog, "utf8").split("\n").filter(Boolean).length : 0);
const headingSizes: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${detail}` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- a minimal DevTools protocol client ----------
let ws: WebSocket;
let seq = 0;
const pending = new Map<number, (v: any) => void>();
const listeners: ((m: any) => void)[] = [];
function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result))));
}
async function js<T = any>(expression: string): Promise<T> {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value as T;
}
/** Waits until the page has loaded and React has attached (the sidebar's links have handlers). */
async function settle() {
  for (let i = 0; i < 100; i++) {
    const ready = await js<boolean>(`document.readyState === "complete" && !!document.querySelector(".sidebar a") &&
      Object.keys(document.querySelector(".sidebar a")).some((k) => k.startsWith("__reactProps"))`).catch(() => false);
    if (ready) return sleep(150);
    await sleep(50);
  }
  throw new Error("page did not become interactive");
}
async function goto(url: string) {
  await send("Page.navigate", { url: BASE + url });
  await sleep(100);
  await settle();
}
/** Waits for navigation that an action started (form submit, link click). */
async function waitForUrl(test: (u: URL) => boolean) {
  for (let i = 0; i < 100; i++) {
    const href = await js<string>("location.href").catch(() => "");
    if (href && test(new URL(href))) return settle();
    await sleep(50);
  }
  throw new Error(`navigation did not happen (now ${await js("location.href")})`);
}
async function click(selector: string) {
  const box = await js<{ x: number; y: number } | null>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
    el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!box) throw new Error(`nothing matches ${selector}`);
  for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  await sleep(150);
}
const KEYS: Record<string, { code: string; keyCode: number }> = {
  Tab: { code: "Tab", keyCode: 9 }, Escape: { code: "Escape", keyCode: 27 }, Enter: { code: "Enter", keyCode: 13 }, k: { code: "KeyK", keyCode: 75 }, " ": { code: "Space", keyCode: 32 },
};
async function press(key: string, modifiers = 0) {
  const k = KEYS[key];
  await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers, ...(key === "Enter" ? { text: "\r" } : {}) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers });
  await sleep(80);
}
const type = (text: string) => send("Input.insertText", { text });
async function viewport(width: number, height: number) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
}
async function shot(name: string) {
  if (!SHOTS) return;
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
}
const text = (selector = "main") => js<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`);
const count = (selector: string) => js<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
/** Waits (up to 8 s) for a condition in the page. */
async function until(expression: string, ms = 8000) {
  for (let i = 0; i < ms / 50; i++) { if (await js<boolean>(expression).catch(() => false)) return true; await sleep(50); }
  return false;
}
/** Replaces a field's text the way typing does, so the page sees it. */
async function setField(selector: string, value: string) {
  await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center" }); el.focus(); el.select(); })()`);
  await type(value);
}
const noSideScroll = () => js<boolean>("document.documentElement.scrollWidth <= window.innerWidth + 1");

async function main() {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  process.env.COMPONENT_LIBRARY_HOME = path.join(t.dir, "db"); // so drafts the server saves can be read here
  server = spawn(path.join(APP, "node_modules/.bin/next"), ["start", "-H", "127.0.0.1", "-p", String(PORT)], {
    cwd: APP, env: { ...process.env, COMPONENT_LIBRARY_HOME: path.join(t.dir, "db"), COMPONENT_LIBRARY_CODE_DIR: path.join(t.dir, "shared"),
      COMPONENT_LIBRARY_GENERATOR: `echo call >> '${aiLog}'; node '${path.join(APP, "tests/create/fake-generator.mjs")}'`, COMPONENT_LIBRARY_TRASH: trashDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/help`)).ok) break; } catch {} await sleep(250); }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cl-chrome-"));
  chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  let target: { webSocketDebuggerUrl: string } | null = null;
  for (let i = 0; i < 80 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()).find((x: any) => x.type === "page"); } catch {}
    if (!target) await sleep(250);
  }
  if (!target) throw new Error("Chrome did not start");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (e) => { const m = JSON.parse(String(e.data)); if (m.id) pending.get(m.id)?.(m); else listeners.forEach((l) => l(m)); });
  await send("Page.enable");
  await send("Runtime.enable");
  await viewport(1536, 1024);

  // ---------- Home ----------
  await goto("/");
  check(`Home shows the first 6 of ${categoryCount} categories`, (await count("main .grid .cat-card")) === 6, String(await count("main .grid .cat-card")));
  const more = await js<string>(`document.querySelector(".show-more")?.innerText ?? ""`);
  check("the Show more control is plain text, no count or icon", more === "Show more categories" && (await count(".show-more svg")) === 0, more);
  check("the Show more control is centered", await js<boolean>(`(() => { const b = document.querySelector(".show-more").getBoundingClientRect(), g = document.querySelector("main .grid").getBoundingClientRect();
    return Math.abs((b.left + b.right) / 2 - (g.left + g.right) / 2) < 2; })()`));
  await shot("home");
  await click(".show-more");
  check("Show more reveals every remaining category", (await count("main .grid .cat-card")) === categoryCount);
  check("the Show more control disappears (not a toggle)", (await count(".show-more")) === 0);
  check("focus moves to the first revealed category", await js<boolean>(`document.activeElement === document.querySelectorAll("main .grid .cat-card")[6]`));
  await shot("home-expanded");

  await press("k", 4); // ⌘K
  check("⌘K focuses the search box", await js<boolean>(`document.activeElement?.id === "search-q"`));
  await type("Does this company use Intercom?");
  await press("Enter");
  await waitForUrl((u) => u.searchParams.get("q") === "Does this company use Intercom?");
  const intercom = await text();
  check("natural-language search still finds the capability", intercom.includes("Website Analysis") && intercom.includes("Matching capability: Support chat detection") && intercom.includes("strong match"));
  await shot("home-search");
  await goto(`/?q=${encodeURIComponent("Analyze customer reviews.")}`);
  const reviews = await text();
  check("a different job is labeled related, not a solution", /Website Analysis\s*· Website Research\s*related/.test(reviews) && reviews.includes("different job"));
  await goto(`/?q=${encodeURIComponent("Build a login and password reset system.")}`);
  check("an unmet request says nothing fits", (await text()).includes("Nothing in the library does this."));

  // ---------- sidebar ----------
  await goto("/");
  const labels = await js<string[]>(`[...document.querySelectorAll(".sidebar .nav-link")].map((a) => a.innerText.trim())`);
  check("the sidebar has the six items in order", JSON.stringify(labels) === JSON.stringify(["Home", "Categories", "Recently Used", "My Projects", "Settings", "Help"]), labels.join(", "));
  check("the current page is marked active", await js<boolean>(`document.querySelector(".sidebar .nav-link.active")?.getAttribute("aria-current") === "page" && document.querySelector(".sidebar .nav-link.active").innerText.trim() === "Home"`));
  check("Settings and Help sit at the bottom", await js<boolean>(`document.querySelector(".sidebar .bottom").getBoundingClientRect().bottom > window.innerHeight - 60`));
  const width = () => js<number>(`document.querySelector(".sidebar").getBoundingClientRect().width`);
  const labelOpacity = () => js<string>(`getComputedStyle(document.querySelector(".sidebar .nav-label")).opacity`);
  const iconX = () => js<number>(`document.querySelector('.sidebar .nav-link[href="/projects"] svg').getBoundingClientRect().left`);
  const mouse = (x: number, y: number) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await mouse(900, 500);
  await sleep(300);
  check("at rest the sidebar shows icons only", await width() === 72 && await labelOpacity() === "0" && (await count(".sidebar .collapse")) === 0);
  check("there is no chevron button", (await count('.sidebar button')) === 0);
  check("at rest every link still has its name for screen readers", await js<boolean>(`[...document.querySelectorAll(".sidebar .nav-link")].every((a) => a.querySelector(".nav-label").textContent.trim())`));
  const contentLeft = await js<number>(`document.querySelector("main").getBoundingClientRect().left`);
  const xAtRest = await iconX();
  await shot("sidebar-collapsed");
  await mouse(30, 300);
  await sleep(350);
  check("hovering opens it, with the labels", await width() === 240 && await labelOpacity() === "1");
  check("it opens over the page, without moving it", await js<number>(`document.querySelector("main").getBoundingClientRect().left`) === contentLeft);
  check("the icons stay where they were", await iconX() === xAtRest);
  await shot("sidebar-hover");
  await click('.sidebar .nav-link[href="/projects"]');
  await waitForUrl((u) => u.pathname === "/projects");
  check("navigation works from the open sidebar", await js<boolean>(`document.querySelector(".sidebar .nav-link.active")?.getAttribute("href") === "/projects"`));
  await mouse(900, 500);
  await sleep(350);
  check("moving away closes it again", await width() === 72);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  check("with reduced motion it opens without sliding", await js<string>(`getComputedStyle(document.querySelector(".sidebar")).transitionDuration`) === "0s");
  await send("Emulation.setEmulatedMedia", { features: [] });

  await goto("/");
  await press("Tab");
  check("the first Tab reaches “Skip to content”", await js<boolean>(`document.activeElement?.classList.contains("skip")`));
  await press("Enter");
  check("Skip to content moves focus to the page", await js<boolean>(`document.activeElement?.id === "content"`));
  await goto("/");
  const order: string[] = [];
  for (let i = 0; i < 9; i++) { await press("Tab"); order.push(await js<string>(`document.activeElement?.getAttribute("aria-label") || document.activeElement?.innerText?.trim() || document.activeElement?.id || document.activeElement?.tagName`)); }
  check("Tab moves through the logo, every nav link, then the search", JSON.stringify(order) === JSON.stringify(
    ["Skip to content", "CLIO home", "Home", "Categories", "Recently Used", "My Projects", "Settings", "Help", "search-q"]), order.join(" → "));
  await goto("/");
  await press("Tab"); await press("Tab"); await press("Tab");
  await sleep(300);
  check("keyboard focus inside the sidebar opens it, so the labels are visible", await js<boolean>(`document.activeElement?.closest(".sidebar") !== null && document.querySelector(".sidebar").getBoundingClientRect().width === 240`));
  for (let i = 0; i < 6; i++) await press("Tab"); // Categories, Recently Used, My Projects, Settings, Help, then the search
  await sleep(300);
  check("…and it closes when focus leaves for the search", await js<boolean>(`document.activeElement?.id === "search-q"`) && await js<number>(`document.querySelector(".sidebar").getBoundingClientRect().width`) === 72,
    `${await js<string>("document.activeElement?.id || document.activeElement?.innerText")} / ${await js<number>(`document.querySelector(".sidebar").getBoundingClientRect().width`)}`);
  check("focus is visible", await js<boolean>(`getComputedStyle(document.activeElement).outlineStyle !== "none" || getComputedStyle(document.activeElement).boxShadow !== "none"`));

  // ---------- Categories ----------
  await goto("/categories");
  check("Categories uses a three-column grid", await js<number>(`getComputedStyle(document.querySelector("main .grid")).gridTemplateColumns.split(" ").length`) === 3);
  check("every category card has an icon, description and real count", await js<boolean>(`[...document.querySelectorAll(".cat-card.tall")].every((c) => c.querySelector(".tile svg") && c.querySelector(".desc") && /^\\d+ components?$/.test(c.querySelector(".count").innerText.trim()))`));
  const counted = await js<Record<string, string>>(`Object.fromEntries([...document.querySelectorAll(".cat-card.tall")].map((c) => [c.querySelector("strong").innerText, c.querySelector(".count").innerText]))`);
  const real = Object.fromEntries(t.lib.categories.list().map((c) => [c.name, `${c.componentCount} component${c.componentCount === 1 ? "" : "s"}`]));
  check("counts match the library", JSON.stringify(Object.keys(counted).sort().map((k) => counted[k])) === JSON.stringify(Object.keys(real).sort().map((k) => real[k])));
  const used = await js<string[]>(`[...document.querySelectorAll(".cat-card.tall strong")].map((s) => s.innerText)`);
  check("Last used (default) puts the most recently used category first", used[0] === "Website Research", used.join(", "));
  await shot("categories");
  await js(`(() => { const s = document.querySelector("select[name=sort]"); s.value = "name"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await waitForUrl((u) => u.searchParams.get("sort") === "name");
  const az = await js<string[]>(`[...document.querySelectorAll(".cat-card.tall strong")].map((s) => s.innerText)`);
  check("choosing A–Z re-sorts the page", JSON.stringify(az) === JSON.stringify([...az].sort((a, b) => a.localeCompare(b))) && az.length === categoryCount, az.join(", "));
  await goto("/categories?sort=added");
  const added = await js<string[]>(`[...document.querySelectorAll(".cat-card.tall strong")].map((s) => s.innerText)`);
  check("Date added puts the newest first", added[0] === "Workflow" || added.slice(0, 4).includes("Workflow"), added.join(", "));
  await goto("/categories");
  await click("#search-q");
  await type("data");
  await press("Enter");
  await waitForUrl((u) => u.searchParams.get("q") === "data");
  check("category search filters the cards", (await count(".cat-card.tall")) >= 1 && (await count(".cat-card.tall")) < categoryCount);
  await goto("/categories?q=zzzz");
  check("no match shows a clear empty state", (await text()).includes("No categories match “zzzz”."));
  await goto("/categories");
  await click('a.button[href^="/categories?new=1"]');
  await waitForUrl((u) => u.searchParams.get("new") === "1");
  await click('#new-category input[name="name"]');
  await type("Interface Components");
  await click('#new-category button[type="submit"]');
  await waitForUrl((u) => u.pathname === "/categories/interface-components");
  check("New category creates it and opens it", (await text()).includes("Interface Components") && (await text()).includes("0 components"));
  await click(".crumb");
  await waitForUrl((u) => u.pathname === "/categories");
  await click('a.cat-card[href="/categories/website-research"]');
  await waitForUrl((u) => u.pathname === "/categories/website-research");
  check("a category card opens its components", (await text()).includes("Website Analysis"));
  await click('a.row-link[href="/components/website-analysis"]');
  await waitForUrl((u) => u.pathname === "/components/website-analysis");

  // ---------- component page ----------
  for (const tab of ["overview", "configuration", "tests", "usage"]) {
    await goto(`/components/website-analysis?tab=${tab}`);
    check(`component ${tab} tab opens and is marked current`, await js<boolean>(`document.querySelector(".tabs a[aria-current=page]")?.innerText.toLowerCase() === "${tab}"`));
  }
  await goto("/components/website-analysis?tab=tests");
  await click('form button[type="submit"]');
  await sleep(800);
  await settle();
  check("Run tests now really runs the command", (await text()).includes("all good") && (await text()).includes("tests passed"));
  await goto("/components/website-analysis?tab=usage");
  check("Usage lists the project that uses it", (await text()).includes("Invoice app"));
  await shot("component");

  // ---------- My Projects ----------
  await goto("/projects");
  check("projects show as rows with real counts", (await text()).includes("Invoice app") && (await text()).includes("1 component") && (await text()).includes("0 components"));
  check("each row says when it was last updated", (await count(".row-link time")) === 2);
  check("no invented favorites, archive or menus", !/Favorites|Archived|Open in Workspace/.test(await text()));
  await click("#search-q");
  await type("billing");
  await press("Enter");
  await waitForUrl((u) => u.searchParams.get("q") === "billing");
  check("project search matches descriptions", (await count(".row-link")) === 1 && (await text()).includes("Invoice app"));
  await goto("/projects?q=nothing-here");
  check("no matching project says so", (await text()).includes("No projects match"));
  await goto("/projects?sort=name");
  check("sort by name", JSON.stringify(await js(`[...document.querySelectorAll(".row-link strong")].map((s) => s.innerText)`)) === JSON.stringify(["Archive tool", "Invoice app"]));
  await shot("projects");
  await goto(`/projects/${project.id}`);
  const facts = await text(".facts");
  check("Overview shows the real details and counts", facts.includes("Billing and contact imports") && /Components used\s*1/.test(facts) && /Test runs\s*1/.test(facts), facts.replace(/\s+/g, " "));
  await shot("project");
  for (const tab of ["components", "runs", "settings"]) {
    await click(`.tabs a[href$="tab=${tab}"]`);
    await waitForUrl((u) => u.searchParams.get("tab") === tab);
    check(`project ${tab} tab opens`, await js<boolean>(`document.querySelector(".tabs a[aria-current=page]")?.getAttribute("href").endsWith("${tab}")`));
    if (tab === "components") check("Remove and Add component still work from here", (await count('input[name=op][value="project.unlink"]')) === 1 && (await count('input[name=op][value="project.link"]')) === 1);
    if (tab === "runs") check("Runs shows the real run, labeled as the component's", (await text()).includes("Tests belong to components") && (await text()).includes("echo all good"));
  }
  await click('input[name="description"]');
  await js(`document.querySelector('input[name="description"]').select()`);
  await type("Billing, invoices and contact imports");
  await click('form button[type="submit"]');
  await waitForUrl((u) => u.searchParams.get("ok") === "Project saved");
  check("Edit project saves and stays on Settings", (await js<string>("location.search")).includes("tab=settings") && t.lib.projects.get(project.id).description === "Billing, invoices and contact imports");

  // ---------- Add project ----------
  await goto("/projects");
  await click('a.button[href="/projects/new"]');
  await waitForUrl((u) => u.pathname === "/projects/new");
  check("Add project offers exactly two choices", JSON.stringify(await js(`[...document.querySelectorAll("a.card.choice strong")].map((s) => s.innerText)`)) === JSON.stringify(["Create project", "Add existing project"]));
  await shot("add-project");
  await click('a.card.choice[href="/projects/add"]');
  await waitForUrl((u) => u.pathname === "/projects/add");
  check("the folder browser starts at the allowed folders", (await text()).includes("Your allowed folders") && (await count(".related-row")) === 1);
  await click(".related-row");
  await waitForUrl((u) => u.searchParams.has("browse"));
  await click(`.related-row[href="/projects/add?browse=${encodeURIComponent(path.join(t.dir, "code"))}"]`);
  await waitForUrl((u) => u.searchParams.get("browse") === path.join(t.dir, "code"));
  check("a folder that looks like a project is marked", (await text(".related-rows")).includes("shop-site") && (await text(".related-rows")).includes("Looks like a project"));
  await click(`.related-row[href$="${encodeURIComponent("shop-site")}"]`);
  await waitForUrl((u) => (u.searchParams.get("browse") ?? "").endsWith("shop-site"));
  await shot("add-existing-browse");
  await click('a.button[href^="/projects/add?path="]');
  await waitForUrl((u) => u.searchParams.has("path"));
  check("choosing it suggests a name and description from its files", await js<string>(`document.querySelector('input[name=name]').value`) === "Shop Site"
    && await js<string>(`document.querySelector('textarea[name=description]').value`) === "The shop's website." && (await text()).includes("Suggested from package.json."));
  await shot("add-existing-review");
  const shopBefore = fs.readdirSync(path.join(t.dir, "code", "shop-site"));
  await js(`document.querySelector('input[name=name]').value = "Shop Website"`);
  await js(`document.querySelector('input[name=op][value="project.register"]').form.querySelector("button[type=submit]").click()`);
  await waitForUrl((u) => /^\/projects\/prj_/.test(u.pathname));
  check("Add project adds it to the library, as edited", (await text()).includes("Project added. Nothing in its folder was changed.") && (await text()).includes("Shop Website"));
  check("nothing in the project folder changed", JSON.stringify(fs.readdirSync(path.join(t.dir, "code", "shop-site"))) === JSON.stringify(shopBefore));
  await goto(`/projects/add?path=${encodeURIComponent(path.join(t.dir, "code", "shop-site"))}`);
  check("a folder already in the library is recognised, with a link to it", (await text()).includes("Already in the library") && (await count('a.button[href^="/projects/prj_"]')) === 1
    && (await count('input[name=op][value="project.register"]')) === 0);
  await goto("/projects/add");
  await click("#path");
  await type(path.join(t.dir, "code", "mailer"));
  await click('form.inline button[type="submit"]');
  await waitForUrl((u) => u.searchParams.has("path"));
  check("typing a path works as a fallback", await js<string>(`document.querySelector('textarea[name=description]').value`) === "Sorts incoming mail.");
  await goto(`/projects/add?path=${encodeURIComponent("/usr")}`);
  check("a folder outside the allowed folders is refused, plainly", (await text('.flash.error')).includes("outside the allowed folders") && (await text()).includes("Choose a folder"));

  // ---------- create project: five steps, no components ----------
  await goto("/projects/new");
  await click('a.card.choice[href="/projects/create"]');
  await waitForUrl((u) => u.pathname === "/projects/create");
  check("Create project starts at step 1 of 5", (await text(".stepbar-label")).includes("Step 1 of 5") && (await count(".stepbar li")) === 5 && (await text("main h1")) === "Create project");
  await click("#prompt");
  await type("A tool that plans my meals for the week");
  let calls = aiCalls();
  await click('form button[type="submit"]');
  await waitForUrl((u) => /^\/projects\/create\/pdr_/.test(u.pathname));
  const mealDraft = await js<string>("location.pathname");
  stepPages.push(mealDraft);
  check("1. a description becomes a plan at step 2, with one AI request", (await text(".stepbar-label")).includes("Step 2 of 5") && (await text("main h1")) === "Create project"
    && (await text(".step-title")) === "Review the plan" && aiCalls() === calls + 1, `${aiCalls() - calls} requests`);
  check("the plan lists what it will do, each with an include box and a remove button", (await count(".features li")) === 4 && (await count('.features li input[type=checkbox]:checked')) === 4
    && (await count(".features li button.icon-button")) === 4 && (await text(".features")).includes("From your description") && (await text(".features")).includes("Suggested"));
  check("nothing exists on disk yet", !fs.existsSync(path.join(t.dir, "Projects", "weekly-dashboard")));
  await shot("create-step-plan");

  // 3–4. edits save themselves
  await setField(".plan-editor label input", "Meal Planner");
  await setField(".plan-editor label textarea", "Plans a week of meals.");
  await setField(".features li:nth-child(1) .feature-text", "Read my favorite recipes");
  await js(`document.querySelector(".features li:nth-child(3) input[type=checkbox]").click()`);
  await js(`document.querySelector(".features li:nth-child(4) button.icon-button").click()`);
  await click('.add-feature input');
  await type("Make a shopping list");
  await click('.add-feature button');
  check("edits save on their own", await until(`document.querySelector(".save-state")?.innerText === "Saved"`));
  await sleep(700);
  let saved = t.lib.projectCreation.get(mealDraft.split("/").pop()!).plan!;
  check("3. the name and description are saved", saved.name === "Meal Planner" && saved.description === "Plans a week of meals.", JSON.stringify([saved.name, saved.description]));
  check("4. a reworded, a left-out, a removed and an added feature are all saved", JSON.stringify(saved.features.map((f) => [f.text, f.included, f.origin])) === JSON.stringify([
    ["Read my favorite recipes", true, "asked"], ["Work out the weekly numbers", true, "asked"], ["Show them on a dashboard page", false, "asked"], ["Make a shopping list", true, "you"]]),
    JSON.stringify(saved.features.map((f) => [f.text, f.included, f.origin])));
  check("a left-out feature is shown crossed out", (await count(".features li.off")) === 1);
  check("editing made no AI request", aiCalls() === calls + 1);

  // 5–6. refine with AI, then undo
  await click("#refine");
  await type("Rename it [rename:Week of Meals] and add [add:Suggest a dessert]");
  await js(`[...document.querySelectorAll(".refine button")].find((b) => b.innerText.includes("Change the plan")).click()`);
  check("5. Make a change to the plan applies the change and says what changed", await until(`document.querySelector(".refined")?.innerText.includes("Added “Suggest a dessert”")`)
    && await js<string>(`document.querySelector(".plan-editor label input").value`) === "Week of Meals");
  const afterRefine = await js<string[]>(`[...document.querySelectorAll(".features .feature-text")].map((i) => i.value)`);
  check("6. the person's own edits are still there after the AI change", JSON.stringify(afterRefine) === JSON.stringify(["Read my favorite recipes", "Work out the weekly numbers", "Show them on a dashboard page", "Make a shopping list", "Suggest a dessert"])
    && (await count(".features li.off")) === 1 && await js<string>(`document.querySelector(".plan-editor label textarea").value`) === "Plans a week of meals.", JSON.stringify(afterRefine));
  await shot("create-step-refined");
  await js(`[...document.querySelectorAll(".refined button")].find((b) => b.innerText.includes("Undo")).click()`);
  check("Undo puts back the plan from before, with the person's edits", await until(`document.querySelector(".plan-editor label input")?.value === "Meal Planner"`)
    && JSON.stringify(await js<string[]>(`[...document.querySelectorAll(".features .feature-text")].map((i) => i.value)`)) === JSON.stringify(["Read my favorite recipes", "Work out the weekly numbers", "Show them on a dashboard page", "Make a shopping list"])
    && (await count(".refined")) === 0);

  // 3 → components
  calls = aiCalls();
  await js(`[...document.querySelectorAll(".step-actions button")].find((b) => b.innerText.includes("Continue to components")).click()`);
  await waitForUrl((u) => u.searchParams.get("step") === "components");
  check("continuing matches components once", aiCalls() === calls + 1 && (await text(".stepbar-label")).includes("Step 3 of 5"));
  check("with nothing that fits, it says so, and what will be built", (await text(".none-found")).includes("No existing components found.") && (await text(".none-found")).includes("Will be built in the project"));
  check("each need has a plain status", (await count(".need .badge")) >= 2 && (await text(".needs")).includes("Will be built in project"));
  await shot("create-step-components-none");

  // 9. back and forward: nothing is redone
  calls = aiCalls();
  await click(`.stepbar a[href$="step=plan"]`);
  await waitForUrl((u) => u.searchParams.get("step") === "plan");
  await js(`[...document.querySelectorAll(".step-actions button")].find((b) => b.innerText.includes("Continue to components")).click()`);
  await waitForUrl((u) => u.searchParams.get("step") === "components");
  await click(`.stepbar a[href$="step=describe"]`);
  await waitForUrl((u) => u.searchParams.get("step") === "describe");
  check("Describe shows the description to change", await js<string>(`document.querySelector("#prompt").value`) === "A tool that plans my meals for the week");
  await js(`document.querySelector('input[name=op][value="projectDraft.replan"]').form.querySelector("button[type=submit]").click()`);
  await waitForUrl((u) => u.searchParams.get("step") === "plan");
  check("9. going back and forward made no AI request and kept every edit", aiCalls() === calls && await js<string>(`document.querySelector(".plan-editor label input").value`) === "Meal Planner", `${aiCalls() - calls} requests`);

  // 10. refresh and resume
  await goto(mealDraft);
  check("10. reopening the draft resumes at the furthest step, as it was", (await text(".stepbar-label")).includes("Step 3 of 5") && aiCalls() === calls);

  // 7. a changed plan makes the components out of date
  await click(`.stepbar a[href$="step=plan"]`);
  await waitForUrl((u) => u.searchParams.get("step") === "plan");
  await js(`document.querySelector(".features li:nth-child(3) input[type=checkbox]").click()`);
  await until(`document.querySelector(".save-state")?.innerText === "Saved"`);
  await sleep(700);
  check("a step whose inputs changed can't be skipped to", await until(`!document.querySelector('.stepbar a[href$="step=build"]')`));
  await js(`[...document.querySelectorAll(".step-actions button")].find((b) => b.innerText.includes("Continue to components")).click()`);
  await waitForUrl((u) => u.searchParams.get("step") === "components");
  check("7. after a change to what it does, components are matched again (once)", aiCalls() === calls + 1);

  // 4. build
  await js(`[...document.querySelectorAll(".step-actions button")].find((b) => b.innerText.includes("Continue to build")).click()`);
  await waitForUrl((u) => u.searchParams.get("step") === "build");
  const summary = await text("dl.summary");
  check("the build step sums it up plainly", ["What will be built", "Components reused", "How it connects", "Setup needed", "Saved to"].every((x) => summary.includes(x))
    && summary.includes("None") && summary.includes(path.join(t.dir, "Projects", "weekly-dashboard")));
  check("details are folded away", (await count("details.more")) >= 1 && (await count("details.more[open]")) === 0);
  await shot("create-step-build");
  await js(`document.querySelector('input[name=folder]').value = "taken"`);
  await js(`document.querySelector('input[name=folder]').form.querySelector("button[type=submit]").click()`);
  await waitForUrl((u) => u.searchParams.get("ok") === "Folder name saved");
  check("an existing folder is never used: no build button, and the reason", (await text()).includes("already exists") && (await count('input[name=op][value="projectDraft.build"]')) === 0);
  await js(`document.querySelector('input[name=folder]').value = "meal-planner"`);
  await js(`document.querySelector('input[name=folder]').form.querySelector("button[type=submit]").click()`);
  await waitForUrl((u) => u.searchParams.get("ok") === "Folder name saved");
  await js(`document.querySelector('input[name=op][value="projectDraft.build"]').form.querySelector("button[type=submit]").click()`);
  check("building says it's built and checked", await until(`document.querySelector(".result.ok")?.innerText.includes("Built and checked")`) && !fs.existsSync(path.join(t.dir, "Projects", "meal-planner")));
  await js(`[...document.querySelectorAll("details.more > summary")].find((s) => s.innerText.startsWith("View files")).click()`);
  check("12. View files lists the project's files to read", (await text("details.more[open]")).includes("app.py") && (await text("details.more[open]")).includes("README.md"));
  await click(`.step-actions a.button`);
  await waitForUrl((u) => u.searchParams.get("step") === "test");
  await js(`document.querySelector('input[name=op][value="projectDraft.test"]').form.querySelector("button[type=submit]").click()`);
  check("13. the test step lists each test, passed", await until(`document.querySelector(".result.ok")?.innerText.includes("All tests passed")`) && (await text(".test-list")).includes("Build") && (await text(".test-list")).includes("Passed"));
  check("the logs are folded away", (await count("details.more:not([open]) > summary")) >= 1 && (await text("details.more > summary")).includes("Test logs"));
  await shot("create-step-test");
  await js(`document.querySelector('input[name=op][value="projectDraft.create"]').form.querySelector("button[type=submit]").click()`);
  await waitForUrl((u) => /^\/projects\/prj_/.test(u.pathname));
  check("approving creates the folder with its files and adds the project", (await text()).includes("Project created in") && fs.existsSync(path.join(t.dir, "Projects", "meal-planner", "app.py"))
    && t.lib.projects.list().some((p) => p.path === path.join(t.dir, "Projects", "meal-planner") && p.name === "Meal Planner"));
  check("no components were created with it", t.lib.projects.list().find((p) => p.path.endsWith("meal-planner"))!.componentCount === 0);
  await shot("create-project-done");

  // 2. a vague idea
  await goto("/projects/create");
  await click("#prompt");
  await type("something with my notes maybe [vague]");
  await click('form button[type="submit"]');
  await waitForUrl((u) => /^\/projects\/create\/pdr_/.test(u.pathname));
  check("2. a vague idea gets a clearly labeled starter project", (await text(".step-title")) === "Here's a small project you could build from that idea" && (await text(".features")).includes("Suggested") && !(await text(".features")).includes("From your description"));
  stepPages.push(await js<string>("location.pathname"));
  await shot("create-step-vague");

  // ---------- words ----------
  for (const p of ["/", "/categories/website-research", "/components/new", "/create", "/projects", "/projects/new", "/projects/add", "/projects/create", "/help", "/settings"]) {
    await goto(p);
    check(`${p} never says "Register"`, !/\bregist/i.test((await text()).replace(/register_(component|project)/g, "")), (await text()).match(/.{0,40}regist.{0,40}/i)?.[0]);
  }

  // ---------- Settings ----------
  await goto("/settings");
  check("Settings lists only real settings", JSON.stringify(await js(`[...document.querySelectorAll(".setting strong")].map((s) => s.innerText)`)) === JSON.stringify(["Data Storage", "Allowed Folders", "Projects Location", "Tests", "Creating Components", "Claude Code", "About"]));
  await click(".setting:nth-of-type(4) summary");
  check("a settings row opens on click", await js<boolean>(`document.querySelectorAll(".setting")[3].open`));
  await js(`document.querySelector('input[name="testTimeoutSeconds"][type="number"]').select()`);
  await click('input[name="testTimeoutSeconds"][type="number"]');
  await js(`document.querySelector('input[name="testTimeoutSeconds"][type="number"]').value = ""`);
  await type("90");
  await js(`document.querySelectorAll(".setting")[3].querySelector("button[type=submit]").click()`);
  await waitForUrl((u) => u.searchParams.get("ok") === "Settings saved");
  const s = t.lib.settings.get();
  check("the time limit saves and the other settings are kept", s.testTimeoutSeconds === 90 && s.allowedRoots.length === 1 && s.allowedRoots[0] === t.dir && s.projectsRoot === path.join(t.dir, "Projects"));
  await click(".setting:nth-of-type(1) summary");
  await shot("settings");

  // ---------- Help ----------
  await goto("/help");
  const articles = await count("[data-help]");
  check("Help has an article for every topic", articles === 11 && await js<boolean>(`["creating", "finding", "capturing", "claude-code", "testing", "versioning", "projects", "troubleshooting"].every((id) => document.getElementById(id)?.hasAttribute("data-help"))`));
  check("every topic card links to an article on the page", await js<boolean>(`[...document.querySelectorAll('[data-help-cards] a[href^="#"]')].every((a) => document.getElementById(a.getAttribute("href").slice(1)))`));
  check("no video, support or fake links", !/video|contact support/i.test(await text()));
  await shot("help");
  await click("#help-search");
  await type("checksum");
  await sleep(200);
  const visible = await js<number>(`[...document.querySelectorAll("[data-help]")].filter((el) => !el.hidden).length`);
  check("help search narrows the articles", visible > 0 && visible < articles && (await text()).includes("mention “checksum”"), String(visible));
  await js(`(() => { const i = document.getElementById("help-search"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, ""); i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await sleep(200);
  check("clearing it shows every article again", (await js<number>(`[...document.querySelectorAll("[data-help]")].filter((el) => !el.hidden).length`)) === articles);

  // ---------- Create a component (with the stand-in AI) ----------
  await goto("/");
  check("Home has a Create component button next to the search", await js<boolean>(`(() => { const b = document.querySelector('.search-row a.button.create[href="/create"]');
    const s = document.querySelector(".search-row .searchbar"); return !!b && b.innerText.trim() === "Create component" && Math.abs(b.getBoundingClientRect().top - s.getBoundingClientRect().top) < 2; })()`));
  await click('a.button.create');
  await waitForUrl((u) => u.pathname === "/create");
  check("the describe card has even edges and steady gaps", await js<boolean>(`(() => {
    const card = document.querySelector(".card.describe").getBoundingClientRect();
    const [title, box, dict, btn] = ["#describe-title", "#prompt", ".dictation", ".card.describe form > button"].map((q) => document.querySelector(q).getBoundingClientRect());
    const r = (n) => Math.round(n);
    // Edges are 24px padding plus the card's 1px border.
    return r(title.top - card.top) === 25 && r(card.bottom - btn.bottom) === 25 && r(box.top - title.bottom) === 8 && r(dict.top - box.bottom) === 16 && r(btn.top - dict.bottom) === 16;
  })()`), await js<string>(`(() => { const card = document.querySelector(".card.describe").getBoundingClientRect();
    const [t, b, d, n] = ["#describe-title", "#prompt", ".dictation", ".card.describe form > button"].map((q) => document.querySelector(q).getBoundingClientRect());
    return [t.top - card.top, b.top - t.bottom, d.top - b.bottom, n.top - d.bottom, card.bottom - n.bottom].map(Math.round).join(", "); })()`));
  check("the extra Claude Code line under the box is gone", !(await text(".card.describe")).includes("suggests a name, category and plan"));
  check("the prompt asks for a description in plain words", (await text()).includes("Describe the component you want to build.") && (await count('a[href="/components/new"]')) === 1);
  await click("#prompt");
  await type("Clean a list of email addresses [new-category]");
  await click('form button[type="submit"]');
  await waitForUrl((u) => /^\/create\/drf_/.test(u.pathname));
  draftUrl = await js<string>("location.pathname");
  let page = await text();
  check("a proposal appears with name, plan, dependencies and tests", page.includes("Email Cleaner") && page.includes("How it will work") && page.includes("standard library only") && page.includes("What the tests will check".slice(0, 0)) && page.includes("Tests"));
  check("no category is chosen for you, and code can't be generated without one", page.includes("Choose a category first") && (await count('input[name=op][value="create.generate"]')) === 0);
  check("the library check gives one result: nothing existing does this", page.includes("No existing components found") && !page.includes("Existing match found")
    && (await count(".existing .ok-icon")) === 1);
  check("related components are listed with their count, as partial matches", await js<boolean>(`document.querySelector(".related-title")?.innerText.replace(/\\s+/g, " ") === "Related components 1 found"`)
    && (await js<string[]>(`[...document.querySelectorAll(".related-row .name strong")].map((s) => s.innerText)`)).join() === "Newsletter Sender"
    && (await text(".related-row")).includes("Partial match"));
  check("a component that only shares words is not shown as related", !(await text(".existing")).includes("Website Analysis") && !(await text(".existing")).includes("Tech Stack Scanner"));
  check("each related row has an icon, a one-line description and a chevron", await js<boolean>(`[...document.querySelectorAll(".related-row")].every((r) => r.querySelectorAll("svg").length === 2 && r.querySelector(".desc").innerText.trim().length > 0)`));
  await click('.related-row[href="/components/newsletter-sender"]');
  await waitForUrl((u) => u.pathname === "/components/newsletter-sender");
  check("clicking a related component opens its page", (await text()).includes("Newsletter Sender"));
  await goto(draftUrl);
  await shot("create-proposal");
  await click("details.reveal > summary.button.secondary");
  check("New category is prefilled with the suggestion, and only created on request", await js<string>(`document.querySelector('input[name=op][value="create.newCategory"]').form.querySelector('input[name=name]').value`) === "Text Tools"
    && !t.lib.categories.list().some((c) => c.name === "Text Tools"));
  await js(`document.querySelector('input[name=op][value="create.newCategory"]').form.querySelector("button[type=submit]").click()`);
  await waitForUrl((u) => u.searchParams.has("ok"));
  check("creating the category also chooses it", t.lib.categories.list().some((c) => c.name === "Text Tools") && await js<string>(`document.querySelector("select[name=category]").value`) === "text-tools");
  await js(`document.querySelector('input[name=op][value="create.generate"]').form.querySelector("button[type=submit]").click()`);
  await waitForUrl((u) => (u.searchParams.get("ok") ?? "").startsWith("Code generated"));
  page = await text();
  check("approving generation shows the files and the safety checks", page.includes("email_cleaner/__init__.py") && page.includes("tests/test_email_cleaner.py") && page.includes("Passed: files only inside the component"));
  check("nothing is in the library yet", !t.lib.components.search("Email Cleaner").some((c) => c.name === "Email Cleaner"));
  await goto(draftUrl);
  check("refreshing keeps the draft where it was", (await text()).includes("email_cleaner/__init__.py") && (await count('input[name=op][value="create.test"]')) === 1);
  await click("details.file summary");
  check("a generated file opens for reading", (await js<string>(`document.querySelector("details.file[open] pre")?.innerText ?? ""`)).includes("def clean"));
  await shot("create-generated");
  await js(`document.querySelector('input[name=op][value="create.test"]').form.querySelector("button[type=submit]").click()`);
  await waitForUrl((u) => u.searchParams.get("ok") === "Tests passed."); // the server's own result, not a guessed delay
  page = await text();
  check("approving tests runs them in the sandbox and shows the result", page.includes("tests passed") && page.includes("Add to the library"));
  await shot("create-tested");
  await js(`document.querySelector('input[name=op][value="create.register"]').form.querySelector("button[type=submit]").click()`);
  await waitForUrl((u) => u.pathname === "/components/email-cleaner");
  page = await text();
  check("approving adds it to the library and releases 1.0.0", page.includes("Added to the library and released as 1.0.0") && page.includes("v1.0.0") && page.includes("intact"));
  check("it is in the category that was chosen", t.lib.components.get("email-cleaner").categorySlug === "text-tools");

  // ---------- create project with a library component ----------
  await goto("/projects/create");
  await click("#prompt");
  await type("Clean my contact list every week and show a summary page [use:email-cleaner] [failing-tests]");
  await click('form button[type="submit"]');
  await waitForUrl((u) => /^\/projects\/create\/pdr_/.test(u.pathname));
  const projDraft = await js<string>("location.pathname");
  await js(`[...document.querySelectorAll(".step-actions button")].find((b) => b.innerText.includes("Continue to components")).click()`);
  await waitForUrl((u) => u.searchParams.get("step") === "components");
  stepPages.push(`${projDraft}?step=components`);
  const cleanerNeed = `[...document.querySelectorAll(".need")].find((n) => n.querySelector(".need-component"))`;
  const needText = () => js<string>(`${cleanerNeed}?.innerText ?? ""`);
  let need = await needText();
  check("the component is shown with its status, version, what it does here and the functions it'll call", need.includes("Available in library") && need.includes("Email Cleaner") && need.includes("1.0.0")
    && need.includes("What it does here:") && need.includes("Calls clean(addresses)") && await js<boolean>(`${cleanerNeed}.querySelector('.need-component input[role=switch]').checked`), need);
  check("only the components that fit are shown", (await count(".need-component")) === 1 && !(await text(".needs")).includes("Website Analysis"));
  check("setup the person does is marked as such", (await text(".needs")).includes("Setup needed"));
  await shot("create-step-components");
  // 8. turn the component off: the need stays, and is built instead
  await js(`${cleanerNeed}.querySelector('.need-component input[role=switch]').click()`);
  need = await needText();
  check("8. turning a component off says what is built instead; the need isn't dropped", need.includes("Will be built in project") && need.includes("Instead, this will be built in the project")
    && need.includes("change the plan"), need);
  check("a required need has no switch to leave it out", !(await js<boolean>(`!!${cleanerNeed}.querySelector(':scope > .need-head > .switch')`)) && need.includes("Needed"));
  const emailIndex = await js<number>(`[...document.querySelectorAll(".need")].findIndex((n) => n.innerText.includes("Setup needed"))`);
  const emailNeed = `document.querySelectorAll(".need")[${emailIndex}]`;
  await js(`${emailNeed}.querySelector(':scope > .need-head > .switch input').click()`);
  check("an optional need can be left out", await js<boolean>(`${emailNeed}.classList.contains("off") && ${emailNeed}.innerText.includes("Left out")`));
  await shot("create-step-components-off");
  await js(`${cleanerNeed}.querySelector('.need-component input[role=switch]').click()`);
  await until(`document.querySelector(".save-state")?.innerText === "Saved"`);
  await sleep(700);
  const pdId = projDraft.split("/").pop()!;
  check("the choices are saved", JSON.stringify(t.lib.projectCreation.decisions(t.lib.projectCreation.get(pdId)).components.map((c) => c.slug)) === '["email-cleaner"]'
    && t.lib.projectCreation.decisions(t.lib.projectCreation.get(pdId)).needs.filter((n) => !n.included).length === 1);
  await js(`[...document.querySelectorAll(".step-actions button")].find((b) => b.innerText.includes("Continue to build")).click()`);
  await waitForUrl((u) => u.searchParams.get("step") === "build");
  stepPages.push(`${projDraft}?step=build`);
  check("the build summary names the component it reuses", (await text("dl.summary")).includes("Email Cleaner 1.0.0"));
  await js(`document.querySelector('input[name=folder]').value = "contact-page"`);
  await js(`document.querySelector('input[name=folder]').form.querySelector("button[type=submit]").click()`);
  await waitForUrl((u) => u.searchParams.get("ok") === "Folder name saved");
  await js(`document.querySelector('input[name=op][value="projectDraft.build"]').form.querySelector("button[type=submit]").click()`);
  check("building copies the component and checks the project calls it", await until(`document.querySelector(".result.ok")?.innerText.includes("calls each component")`));
  await js(`[...document.querySelectorAll("details.more > summary")].find((s) => s.innerText === "Integration details").click()`);
  check("integration details say what's copied and called", (await text("details.more[open]")).includes("copied unchanged into components/email-cleaner/") && (await text("details.more[open]")).includes("clean"));
  await shot("create-step-build-component");
  await click(`.step-actions a.button`);
  await waitForUrl((u) => u.searchParams.get("step") === "test");
  await js(`document.querySelector('input[name=op][value="projectDraft.test"]').form.querySelector("button[type=submit]").click()`);
  check("failed tests are shown plainly, with Fix and no create button", await until(`document.querySelector(".result.bad")?.innerText.includes("The tests failed")`)
    && (await text(".test-list")).includes("Failed") && (await text("details.fix > summary")).trim() === "Fix" && (await count('input[name=op][value="projectDraft.create"]')) === 0);
  stepPages.push(`${projDraft}?step=test`);
  await shot("create-step-test-failed");
  // 14. fix with AI
  await js(`document.querySelector('details.fix input[name=op][value="projectDraft.build"]').form.querySelector("button[type=submit]").click()`);
  check("after Fix, the old results don't count", await until(`!!document.querySelector('input[name=op][value="projectDraft.test"]') && !document.querySelector(".result")`));
  await js(`document.querySelector('input[name=op][value="projectDraft.test"]').form.querySelector("button[type=submit]").click()`);
  check("14. the fixed project's tests pass", await until(`document.querySelector(".result.ok")?.innerText.includes("All tests passed")`));
  const testsPage = await text("dl.summary");
  check("the components called and the copy check are reported", testsPage.includes("Email Cleaner: called clean") && testsPage.includes("Yes, byte for byte") && testsPage.includes("None"), testsPage);
  await shot("create-step-test-passed");
  // 11. a choice changed after testing blocks creating from the old build
  await click(`.stepbar a[href$="step=components"]`);
  await waitForUrl((u) => u.searchParams.get("step") === "components");
  await js(`${cleanerNeed}.querySelector('.need-component input[role=switch]').click()`);
  await until(`document.querySelector(".save-state")?.innerText === "Saved"`);
  await goto(`${projDraft}?step=test`);
  check("11. after a change, the old build and tests can't be used", (await text(".stepbar-label")).includes("Build") && (await text()).includes("changed after the last build") && (await count('input[name=op][value="projectDraft.create"]')) === 0);
  await goto(`${projDraft}?step=components`);
  await js(`${cleanerNeed}.querySelector('.need-component input[role=switch]').click()`);
  await until(`document.querySelector(".save-state")?.innerText === "Saved"`);
  await goto(`${projDraft}?step=test`);
  check("changing it back makes the tested build count again, with no new request", (await text(".stepbar-label")).includes("Test") && (await count('input[name=op][value="projectDraft.create"]')) === 1);
  // 15. create
  await js(`document.querySelector('input[name=op][value="projectDraft.create"]').form.querySelector("button[type=submit]").click()`);
  await waitForUrl((u) => /^\/projects\/prj_/.test(u.pathname));
  const contactProject = await js<string>("location.pathname");
  await goto(`${contactProject}?tab=components`);
  check("15. the project shows the component as Connected at its version", (await text("table")).includes("Email Cleaner") && (await text("table")).includes("1.0.0") && (await count("td .badge.connected")) === 1);
  check("the copy on disk is the release, unchanged", fs.readFileSync(path.join(t.dir, "Projects", "contact-page", "components", "email-cleaner", "RELEASE.json"), "utf8").includes('"version": "1.0.0"'));
  await goto(projDraft);
  check("the finished draft shows it was created, and can't be edited", (await text()).includes("The project was created") && (await count(`input[name=op][value^="projectDraft."]`)) === 0);
  await shot("project-connected");

  // ---------- adding a component to an existing project ----------
  const appFile = path.join(projectDir, "app.py");
  fs.writeFileSync(appFile, "def hello():\n    return 'hi'\n");
  await goto(`/projects/${project.id}?tab=components&add=email-cleaner`);
  check("adding shows exactly what will be copied, and the code to paste", (await text()).includes(path.join(projectDir, "components", "email-cleaner")) && (await text("pre")).includes("from email_cleaner import clean"));
  await js(`document.querySelector('input[name=op][value="project.addComponent"]').form.querySelector("button[type=submit]").click()`);
  await waitForUrl((u) => (u.searchParams.get("ok") ?? "").startsWith("Added Email Cleaner"));
  check("it shows as Added, not Connected", (await count("td .badge.added")) === 1 && (await count("td .badge.connected")) === 0);
  check("nothing else in the project changed", fs.readFileSync(appFile, "utf8") === "def hello():\n    return 'hi'\n" && JSON.stringify(fs.readdirSync(projectDir).sort()) === JSON.stringify(["app.py", "components"]));
  check("an older hand-made link still says Recorded", (await text("table")).includes("Recorded"));
  await shot("existing-added");
  await js(`[...document.querySelectorAll('input[name=op][value="project.checkConnection"]')].find((i) => i.form.querySelector('input[name=component]').value === ${JSON.stringify(t.lib.components.get("email-cleaner").id)}).form.querySelector("button[type=submit]").click()`);
  await waitForUrl((u) => u.searchParams.has("error"));
  check("checking a project with no tests says why it isn't connected", (await text(".flash.error")).includes("no tests"));
  fs.writeFileSync(path.join(projectDir, "contacts.py"), `import os, sys\nsys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "components/email-cleaner/email-cleaner"))\nfrom email_cleaner import clean\n\n\ndef tidy(rows):\n    return clean(rows)\n`);
  fs.mkdirSync(path.join(projectDir, "tests"));
  fs.writeFileSync(path.join(projectDir, "tests", "test_contacts.py"), "import unittest\nimport contacts\n\n\nclass C(unittest.TestCase):\n    def test_tidy(self):\n        self.assertEqual(contacts.tidy([' A@x.com']), ['a@x.com'])\n");
  await js(`[...document.querySelectorAll('input[name=op][value="project.checkConnection"]')].find((i) => i.form.querySelector('input[name=component]').value === ${JSON.stringify(t.lib.components.get("email-cleaner").id)}).form.querySelector("button[type=submit]").click()`);
  await waitForUrl((u) => (u.searchParams.get("ok") ?? "").startsWith("Connected"));
  check("once its own tests call it, it becomes Connected", (await count("td .badge.connected")) === 1 && (await text(".flash.ok")).includes("called clean"));
  await shot("create-released");

  await goto("/create");
  await click("#prompt");
  await type("Clean up email addresses and remove duplicates [cat:data-handling] [name:Address Tidy]");
  await click('form button[type="submit"]');
  await waitForUrl((u) => /^\/create\/drf_/.test(u.pathname));
  page = await text(".existing");
  check("a component that already does it shows as an existing match, clearly named", page.includes("Existing match found") && !page.includes("No existing components found")
    && (await js<string>(`document.querySelector(".existing .related-rows .related-row strong")?.innerText ?? ""`)) === "Email Cleaner" && page.includes("Same job"));
  check("partial matches stay separate from the full match", await js<boolean>(`document.querySelector(".related-title")?.innerText.replace(/\\s+/g, " ") === "Related components 2 found"`)
    && (await count(".existing .related-row .badge:not(.accent)")) === 2);
  check("an existing match changes the button to Generate anyway", (await text()).includes("Generate anyway"));
  await shot("create-existing-match");
  await viewport(390, 844);
  await goto(await js<string>("location.pathname"));
  check("the library check fits a phone screen", await noSideScroll() && await js<boolean>(`[...document.querySelectorAll(".related-row")].every((r) => r.getBoundingClientRect().right <= window.innerWidth)`));
  await shot("create-existing-match-phone");
  await viewport(1536, 1024);
  await goto(await js<string>("location.pathname"));
  await js(`document.querySelector('input[name=op][value="create.discard"]').form.querySelector("button[type=submit]").click()`);
  await waitForUrl((u) => u.pathname === "/create");

  await goto("/create");
  await click("#prompt");
  await type("Something I will change my mind about [cat:data-handling]");
  await click('form button[type="submit"]');
  await waitForUrl((u) => /^\/create\/drf_/.test(u.pathname));
  const discarded = await js<string>("location.pathname");
  check("with nothing related, the divider and Related components are hidden", (await text(".existing")).includes("No existing components found")
    && (await count(".existing .divider-line")) === 0 && (await count(".existing .related-title")) === 0);
  await js(`document.querySelector('input[name=op][value="create.discard"]').form.querySelector("button[type=submit]").click()`);
  await waitForUrl((u) => u.pathname === "/create");
  check("discarding a draft removes it and changes nothing else", (await text()).includes("Draft discarded. Nothing was added to the library.") && (await count(`a[href="${discarded}"]`)) === 0);

  // ---------- progress feedback (the stand-in takes 3 s with [slow]) ----------
  await goto("/create");
  await click("#prompt");
  await type("Tidy up a list of postal codes [slow] [cat:data-handling] [name:Postcode Tidy]");
  await click('form button[type="submit"]');
  await sleep(500);
  check("describing shows progress at once, in words", await js<boolean>(`!!document.querySelector('form[aria-busy="true"] .progress[role="status"]')`)
    && (await text(".progress")).includes("Checking your library and writing the proposal"));
  check("the button is disabled while it runs", await js<boolean>(`document.querySelector('form[aria-busy="true"] button[type="submit"]').disabled`));
  check("navigation stays available while it runs", await js<boolean>(`[...document.querySelectorAll(".sidebar a")].every((a) => !a.hasAttribute("disabled") && a.getAttribute("aria-disabled") !== "true")`));
  await waitForUrl((u) => /^\/create\/drf_/.test(u.pathname));
  const slowDraft = await js<string>("location.pathname");
  const slowId = slowDraft.split("/").pop()!;
  check("it ends with a clear success message", (await text()).includes("The proposal is ready to review.") || (await text()).includes("Proposal"));

  await js(`document.querySelector('input[name=op][value="create.generate"]').form.querySelector("button[type=submit]").click()`);
  await sleep(150);
  await js(`document.querySelector('input[name=op][value="create.generate"]').form.requestSubmit()`); // a second click while it runs
  await sleep(1800);
  check("long steps show the server's own message", (await text(".progress")).includes("Generating code…"), await text(".progress"));
  await js(`document.querySelector(".progress")?.scrollIntoView({ block: "center" })`);
  await shot("progress-generating");
  check("other steps of the same draft wait meanwhile", await js<boolean>(`document.querySelector('input[name=op][value="create.discard"]').form.querySelector("button[type=submit]").disabled
    && [...document.querySelectorAll("button")].find((b) => b.innerText === "Discard this draft").disabled`));
  check("the bar moves, in the purple accent", await js<boolean>(`(() => { const s = getComputedStyle(document.querySelector(".progress-bar span")); return s.animationName === "progress-slide" && s.backgroundColor === "rgb(146, 111, 250)"; })()`));
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  check("with reduced motion it holds still", await js<boolean>(`getComputedStyle(document.querySelector(".progress-bar span")).animationName === "none"`));
  await send("Emulation.setEmulatedMedia", { features: [] });
  await waitForUrl((u) => u.searchParams.has("ok"));
  check("generation ends with a success message", (await text()).includes("Code generated and checked."));
  const slowDraftJson = JSON.parse(fs.readFileSync(path.join(t.dir, "db", "staging", slowId, "draft.json"), "utf8"));
  check("the second click did not start a second generation", slowDraftJson.generation.attempt === 1, String(slowDraftJson.generation.attempt));
  check("…and was quietly ignored, not sent and refused", (await count(".flash.error")) === 0);

  // Refresh in the middle: start "Fix with AI" from outside the page, then open the page while it runs.
  const background = fetch(`${BASE}/api/do`, { method: "POST", headers: { "x-fetch": "1" }, body: new URLSearchParams({ op: "create.generate", draft: slowId, feedback: "Make it shorter [slow]" }) });
  await sleep(600);
  await goto(slowDraft);
  await js(`document.querySelector(".progress")?.scrollIntoView({ block: "center" })`);
  await shot("progress-after-refresh");
  check("after a refresh, a step the server confirms is running shows live progress", (await count('.progress[role="status"]')) === 1
    && /Fixing the code…|Preparing your component…|Checking the files for safety…/.test(await text(".progress")), await text(".progress"));
  check("the draft's buttons wait while it runs", await js<boolean>(`[...document.querySelectorAll('input[name=op][value^="create."]')].every((i) => i.form.querySelector("button[type=submit]").disabled)`),
    await js<string>(`[...document.querySelectorAll('input[name=op][value^="create."]')].filter((i) => !i.form.querySelector("button").disabled).map((i) => i.value).join(", ")`));
  await background;
  for (let i = 0; i < 40 && !(await text()).includes("attempt 2"); i++) await sleep(250);
  check("when it finishes, the page updates by itself", (await text()).includes("attempt 2") && (await count(".progress")) === 0);
  await goto(slowDraft);
  check("with nothing running, no progress is shown", (await count(".progress")) === 0 && !(await text()).includes("Working on"));

  // Failure, then retry.
  await goto("/create");
  await click("#prompt");
  await type("Clean a list of email addresses [fail-generate] [cat:data-handling] [name:Broken Tidy]");
  await click('form button[type="submit"]');
  await waitForUrl((u) => /^\/create\/drf_/.test(u.pathname));
  await js(`document.querySelector('input[name=op][value="create.generate"]').form.querySelector("button[type=submit]").click()`);
  for (let i = 0; i < 40 && !(await count('.flash.error[role="alert"]')); i++) await sleep(150);
  check("a failure says what happened, and can be tried again", (await text('.flash.error[role="alert"]')).includes("That didn't work.") && (await text('.flash.error[role="alert"]')).includes("not JSON")
    && await js<boolean>(`!document.querySelector('input[name=op][value="create.generate"]').form.querySelector("button[type=submit]").disabled`));
  check("after a failure nothing claims to be running", (await count(".progress")) === 0);
  await js(`document.querySelector(".flash.error")?.scrollIntoView({ block: "center" })`);
  await shot("progress-failure");

  // ---------- dictation (a stand-in microphone and speech engine; headless Chrome has neither) ----------
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    const scenario = localStorage.getItem("fake-speech");
    if (!scenario) return;
    window.__tracksStopped = 0;
    if (scenario === "unsupported") { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; return; }
    navigator.mediaDevices.getUserMedia = async () => {
      if (scenario === "denied") throw new DOMException("denied", "NotAllowedError");
      if (scenario === "nomic") throw new DOMException("none", "NotFoundError");
      return { getTracks: () => [{ stop: () => { window.__tracksStopped++; } }] };
    };
    class Fake {
      constructor() { this.processLocally = false; window.__lastRec = this; }
      start() {
        setTimeout(() => this.onstart && this.onstart(), 30);
        const say = (results, i) => setTimeout(() => this.onresult && this.onresult({ resultIndex: i, results }), 0);
        if (scenario === "ok") {
          setTimeout(() => say([Object.assign([{ transcript: "hello wor" }], { isFinal: false })], 0), 80);
          setTimeout(() => say([Object.assign([{ transcript: "hello world" }], { isFinal: true })], 0), 200);
          setTimeout(() => say([Object.assign([{ transcript: "hello world" }], { isFinal: true }), Object.assign([{ transcript: " second part" }], { isFinal: true })], 1), 320);
        } else {
          const error = { network: "network", nospeech: "no-speech" }[scenario];
          setTimeout(() => { this.onerror && this.onerror({ error }); this.onend && this.onend(); }, 120);
        }
      }
      stop() { setTimeout(() => this.onend && this.onend(), 400); }
      abort() { this.onend && this.onend(); }
    }
    Fake.available = async () => (localStorage.getItem("fake-speech-local") === "installed" ? "available" : "downloadable");
    Fake.install = async () => { localStorage.setItem("fake-speech-local", "installed"); return true; };
    window.SpeechRecognition = Fake;
    window.webkitSpeechRecognition = Fake;
  })();` });
  const scenario = async (name: string, url = "/create") => {
    await goto(url);
    await js(`localStorage.setItem("fake-speech", ${JSON.stringify(name)}); localStorage.removeItem("fake-speech-local")`);
    await goto(url);
  };
  const status = () => text(".dictation-status");
  const box = () => js<string>(`document.getElementById("prompt").value`);
  const dictate = () => js(`document.querySelector(".dictation button").click()`);

  for (const url of ["/create", "/projects/create"]) {
    await scenario("ok", url);
    check(`${url}: the description box has a Dictate button`, (await text(".dictation button")).includes("Dictate"));
  }
  await scenario("ok");
  check("before dictating it says where speech is turned into text", (await status()).includes("Ready to dictate") && (await status()).includes("Google's speech service") && (await status()).includes("no audio is kept"));
  await click("#prompt");
  await type("My idea:");
  await dictate();
  await sleep(150);
  check("pressing Dictate shows the listening state with the pulsing microphone", (await status()).includes("Listening") && (await count(".dictation .mic-pulse")) === 1
    && await js<boolean>(`document.querySelector(".dictation button").getAttribute("aria-pressed") === "true"`));
  for (let i = 0; i < 20 && !(await box()).includes("hello"); i++) await sleep(25);
  check("words appear in the text box as they're spoken, not next to the microphone", (await box()).startsWith("My idea: hello") && (await status()).trim() === "Listening…", `${await box()} | ${await status()}`);
  check("the pulse is in the purple accent", await js<boolean>(`getComputedStyle(document.querySelector(".mic-pulse")).color === "rgb(146, 111, 250)" && getComputedStyle(document.querySelector(".mic-pulse")).animationName === "mic-pulse"`));
  await shot("dictation-listening");
  await sleep(400);
  check("speech is added after the text already there", await box() === "My idea: hello world second part", await box());
  await dictate(); // Stop
  await sleep(100);
  check("stopping shows Transcribing until the browser finishes", (await status()).includes("Transcribing"));
  await sleep(500);
  check("then it finishes quietly: the words are in the box, no extra message", (await status()).trim() === "" && (await text(".dictation button")).trim() === "Dictate");
  check("the microphone stream was closed (nothing recorded or kept)", await js<number>("window.__tracksStopped") === 1);
  await shot("dictation-finished");
  await click("#prompt");
  await js(`(() => { const el = document.getElementById("prompt"); el.setSelectionRange(el.value.length, el.value.length); })()`);
  await type(". Edited.");
  check("the transcription can be edited before submitting", (await box()).endsWith("second part. Edited."));
  await dictate(); // the same Dictate button starts again
  await sleep(600);
  await dictate(); // Stop
  await sleep(600);
  check("dictating again adds more, keeping everything before", await box() === "My idea: hello world second part. Edited. Hello world second part", await box());

  await scenario("denied");
  await click("#prompt");
  await type("Typed by hand");
  await dictate();
  await sleep(200);
  check("a refused microphone is explained, and typing still works", (await status()).includes("Microphone access was blocked") && (await text(".dictation button")).trim() === "Dictate"
    && await box() === "Typed by hand" && await js<boolean>(`!document.getElementById("prompt").disabled`));
  check("a warning is red, with a red icon and smaller text", await js<boolean>(`(() => { const st = getComputedStyle(document.querySelector(".dictation-status")); const ic = getComputedStyle(document.querySelector(".dictation-status svg"));
    return st.color === "rgb(224, 96, 90)" && ic.color === "rgb(224, 96, 90)" && st.fontSize === "12px"; })()`));
  await shot("dictation-denied");
  await scenario("nomic");
  await dictate();
  await sleep(200);
  check("no microphone is explained", (await status()).includes("No microphone was found"));
  await scenario("network");
  await dictate();
  await sleep(400);
  check("a speech service failure is explained, nothing is added", (await status()).includes("couldn't be reached") && await box() === "");
  await scenario("nospeech");
  await dictate();
  await sleep(400);
  check("hearing nothing is explained", (await status()).includes("No speech was heard"));
  await scenario("unsupported");
  check("a browser without speech recognition gets a disabled button and a reason", await js<boolean>(`document.querySelector(".dictation button").disabled`)
    && (await text(".dictation")).includes("can't turn speech into text") && (await text(".dictation")).includes("Fn key twice"));

  await scenario("ok");
  check("on-device speech is offered when Chrome can download it", (await count('.dictation button.link')) === 1);
  await js(`document.querySelector(".dictation button.link").click()`);
  await sleep(200);
  check("once installed, it says speech stays on this Mac", (await status()).includes("Speech is turned into text on this Mac") && (await count('.dictation button.link')) === 0);
  await dictate();
  await sleep(150);
  check("and asks the browser to recognise on the device", await js<boolean>("window.__lastRec.processLocally === true"));
  await dictate();
  await sleep(500);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await dictate();
  await sleep(150);
  check("with reduced motion the microphone doesn't pulse", await js<boolean>(`getComputedStyle(document.querySelector(".mic-pulse")).animationName === "none"`));
  await send("Emulation.setEmulatedMedia", { features: [] });
  await js(`localStorage.removeItem("fake-speech"); localStorage.removeItem("fake-speech-local")`);

  // ---------- requests from another website are refused ----------
  const post = (headers: Record<string, string>) => fetch(`${BASE}/api/do`, { method: "POST", headers: { "x-fetch": "1", ...headers },
    body: new URLSearchParams({ op: "category.create", name: "Planted by another site" }) });
  check("a form posted from another website is refused", (await post({ Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" })).status === 403);
  // fetch() can't set Host, so this one goes through node:http, which sends exactly what it's given.
  const rebinding = await new Promise<number>((resolve, reject) => {
    const body = new URLSearchParams({ op: "category.create", name: "Planted by another site" }).toString();
    const req = http.request({ host: "127.0.0.1", port: PORT, path: "/api/do", method: "POST",
      headers: { Host: "evil.example:4412", "x-fetch": "1", "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) } },
      (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", reject);
    req.end(body);
  });
  check("a request for another host name (DNS rebinding) is refused", rebinding === 403, String(rebinding));
  check("nothing was created by those requests", !t.lib.categories.list().some((c) => c.name === "Planted by another site"));
  const own = await fetch(`${BASE}/api/do`, { method: "POST", headers: { "x-fetch": "1", Origin: BASE, "Sec-Fetch-Site": "same-origin" },
    body: new URLSearchParams({ op: "category.create", name: "Made by this app" }) });
  check("the app's own pages can still post", own.status === 200 && t.lib.categories.list().some((c) => c.name === "Made by this app"), String(own.status));


  // ---------- confirm before deleting ----------
  const dialogOpen = () => js<boolean>(`!!document.querySelector("dialog.confirm-dialog[open]")`);
  const dialogButton = `document.querySelector("dialog.confirm-dialog[open] .dialog-actions button[type=submit]")`;
  const archive = t.lib.projects.list().find((x) => x.name === "Archive tool")!;
  await goto(`/projects/${archive.id}?tab=settings`);
  await js(`[...document.querySelectorAll("button")].find((b) => b.innerText === "Remove project").click()`);
  check("Remove project opens a confirm box first; nothing is removed yet", await dialogOpen() && (await text("dialog[open]")).includes("Remove “Archive tool”?") && t.lib.projects.list().some((x) => x.id === archive.id));
  check("it offers library only (chosen) or the folder to the Trash too", await js<boolean>(`document.querySelector('dialog[open] input[value=keep]').checked`) && (await text("dialog[open]")).includes("Move folder to the Trash"));
  check("the red button stays off until delete is typed", await js<boolean>(`${dialogButton}.disabled`) && await js<string>(`getComputedStyle(${dialogButton}).backgroundColor`) !== "rgba(0, 0, 0, 0)");
  await shot("confirm-remove-project");
  await press("Escape");
  check("Esc closes it and nothing happens", !(await dialogOpen()) && t.lib.projects.list().some((x) => x.id === archive.id));
  await js(`[...document.querySelectorAll("button")].find((b) => b.innerText === "Remove project").click()`);
  await js(`[...document.querySelectorAll("dialog[open] button")].find((b) => b.innerText === "Cancel").click()`);
  check("Cancel closes it and nothing happens", !(await dialogOpen()) && t.lib.projects.list().some((x) => x.id === archive.id));
  await js(`[...document.querySelectorAll("button")].find((b) => b.innerText === "Remove project").click()`);
  await click("dialog[open] input[value=trash]");
  await click("dialog[open] input[name=confirm]");
  await type("dele");
  check("half the word isn't enough", await js<boolean>(`${dialogButton}.disabled`));
  await type("te");
  check("typing delete turns the red button on", !(await js<boolean>(`${dialogButton}.disabled`)));
  await sleep(300);
  await shot("confirm-remove-project-typed");
  await js(`${dialogButton}.click()`);
  await waitForUrl((u) => u.pathname === "/projects");
  check("removing with the Trash choice moves the folder to the Trash (never deletes it)", (await text(".flash.ok")).includes("Its folder is in the Trash") && !fs.existsSync(archive.path)
    && fs.existsSync(path.join(trashDir, path.basename(archive.path))) && !t.lib.projects.list().some((x) => x.id === archive.id));
  const cat = t.lib.categories.list().find((x) => x.name === "Workflow")!;
  await goto(`/categories/${cat.slug}`);
  await js(`document.querySelector("details.setting").open = true`);
  await js(`[...document.querySelectorAll("button")].find((b) => b.innerText === "Delete category").click()`);
  check("deleting a category asks first, with a red button and no typing", await dialogOpen() && (await count("dialog[open] input[name=confirm]")) === 0 && !(await js<boolean>(`${dialogButton}.disabled`)));
  await js(`${dialogButton}.click()`);
  await waitForUrl((u) => u.pathname === "/categories");
  check("approving deletes it", !t.lib.categories.list().some((x) => x.id === cat.id));
  const busyCat = t.lib.categories.list().find((x) => x.componentCount > 0)!;
  await goto(`/categories/${busyCat.slug}`);
  await js(`document.querySelector("details.setting").open = true`);
  await js(`[...document.querySelectorAll("button")].find((b) => b.innerText === "Delete category").click()`);
  check("a category that still has components says why, and can't be deleted", (await text("dialog[open]")).includes("Move or delete them first") && await js<boolean>(`${dialogButton}.disabled`));
  await shot("confirm-category-blocked");
  await goto("/components/website-analysis?tab=configuration");
  await js(`[...document.querySelectorAll("button")].find((b) => b.innerText === "Delete component").click()`);
  check("deleting a component in use says which project, and can't be done", (await text("dialog[open]")).includes("used by Invoice app") && await js<boolean>(`${dialogButton}.disabled`));
  await shot("confirm-component-in-use");
  await press("Escape");

  // ---------- every page: labels, buttons, phone width ----------
  const pages = ["/projects/new", "/projects/add", "/projects/create", "/create", draftUrl, ...stepPages, `/projects/${project.id}?tab=components&add=email-cleaner`, "/", "/categories", "/categories/website-research", "/recent", "/projects", `/projects/${project.id}`, `/projects/${project.id}?tab=components`,
    "/settings", "/help", "/components/website-analysis", "/components/website-analysis?tab=configuration", "/components/new", "/projects/new"];
  for (const p of pages) {
    await goto(p);
    const unlabeled = await js<string[]>(`[...document.querySelectorAll("input:not([type=hidden]), select, textarea")].filter((el) =>
      !(el.labels?.length || el.getAttribute("aria-label"))).map((el) => el.name || el.id)`);
    // textContent, not innerText: controls inside a closed section have no visible text until it opens, but still have a name.
    const nameless = await js<string[]>(`[...document.querySelectorAll("button, a")].filter((el) => !(el.textContent.trim() || el.getAttribute("aria-label"))).map((el) => el.outerHTML.slice(0, 80))`);
    headingSizes.push(`${p}=${await js<string>(`getComputedStyle(document.querySelector("main h1")).fontSize`)}`);
    check(`${p}: every field has a label and every control a name`, unlabeled.length === 0 && nameless.length === 0, `unlabeled: ${unlabeled.join(", ")}; nameless: ${nameless.join(" | ")}`);
  }
  check("every page heading is the same size (40px)", headingSizes.every((h) => h.endsWith("=40px")), headingSizes.filter((h) => !h.endsWith("=40px")).join(", "));
  await viewport(390, 844);
  const phoneSizes: string[] = [];
  for (const p of pages) {
    await goto(p);
    check(`${p} fits a phone screen with no sideways scrolling`, await noSideScroll(), String(await js("document.documentElement.scrollWidth")));
    phoneSizes.push(`${p}=${await js<string>(`getComputedStyle(document.querySelector("main h1")).fontSize`)}`);
  }
  check("on a phone every page heading is the same size (32px)", phoneSizes.every((h) => h.endsWith("=32px")), phoneSizes.filter((h) => !h.endsWith("=32px")).join(", "));
  await goto("/");
  check("on a phone the sidebar shows icons only", await js<number>(`document.querySelector(".sidebar").getBoundingClientRect().width`) === 56);
  check("on a phone the categories stack in one column", await js<number>(`getComputedStyle(document.querySelector("main .grid")).gridTemplateColumns.split(" ").length`) === 1);
  await shot("phone-home");
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(async () => {
    try { ws?.close(); } catch {}
    chrome?.kill("SIGTERM");
    if (server) await new Promise<void>((resolve) => { server!.once("exit", () => resolve()); server!.kill("SIGTERM"); });
    const rel = path.join(t.dir, "shared", "releases");
    if (fs.existsSync(rel)) unlockTree(rel); // releases are read-only on purpose
    t.close();
    console.log(failures ? `\n${failures} FAILED` : "\nall interface checks passed");
    process.exit(failures ? 1 : 0);
  });
