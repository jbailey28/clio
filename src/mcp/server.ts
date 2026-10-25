/**
 * Component Library MCP server (stdio). A thin adapter: every tool calls the
 * service layer from src/core and nothing else. It opens the same SQLite
 * database as the browser app and does not need the app to be running.
 *
 * Approval boundary: every tool that changes the library, or runs a stored
 * shell command, first asks the user through MCP elicitation, a prompt that
 * Claude Code shows to the person, not to the model. Declined, cancelled, or
 * unsupported means no change. Tool descriptions and annotations only help
 * the model choose; they are not what enforces this.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { slugify } from "../core/util";
import { type ComponentDetail, type ComponentInput, type FunctionalityMatch, type Library } from "../core";
import { isLibraryError } from "../core/errors";

const INSTRUCTIONS = `Component Library: your shared, local library of reusable code.

Before building substantial new functionality, call find_reusable_functionality with a plain-language description of what is needed (no need to know component names). Each match says how strong it is:
- strong: a capability already does what was asked.
- partial: it covers part of the request; "unmatched" says what is missing.
- related: same subject but a different job (for example, detecting email tools versus sending email). Never present a related result as a solution.
Matches name the capability that matched and why. Before recommending reuse, call get_component and read its documentation, source paths, dependencies and latest test results, then tell the user whether it fully or partially solves the request. Treat "tests not run" as unknown, not as passing or failing. A partial or related match is information, not a reason to refuse building something new; if nothing matches, say the library has nothing for it rather than stretching an unrelated component.

Changing the library follows a proposal workflow:
1. Identify functionality that is genuinely reusable across projects (not trivial, not project-specific).
2. Call check_for_duplicates.
3. Describe to the user, in chat, exactly what you would add or change.
4. Ask the user. Only after they agree in chat, call the write tool.
5. The write tool then shows its own approval prompt; the user must accept it there too. If they decline, stop.

Capturing reusable code from a project:
- When to suggest it: only after finishing a meaningful piece of work, and only when it solves a problem that will come up again, has a clear interface (inputs in, outputs out), can run without the application's internal state, and the library has nothing equivalent. Not for small helpers, glue code, UI specific to one app, or anything where extracting it adds more complexity than it saves. Suggest at most once per piece of work, in one or two sentences, and drop it if the user says no. Never interrupt ordinary work to suggest it.
- Check first: find_reusable_functionality with what the code does. Strong match: recommend reusing it instead. Partial: recommend extending it (update_component, then a new release). Related: say how it differs. None: propose a new component.
- Propose: call propose_capture (read-only; changes nothing). Show the user, in chat, the suggested name and category, what it does, why it is reusable, the files included and excluded, dependencies, inputs and outputs, existing tests, what must be separated from the project, and limitations or risks. Include its signals and blockers. Wait for agreement. If they decline, change nothing.
- Separate safely: never move, delete or edit the original project's files. If the code reaches into the application (reachesOutside), prepare a separated copy in ~/.component-library/staging/<slug>/ and propose_capture that copy. If the original project itself must change, explain the change and ask for separate approval. Never copy credentials, secrets, customer data, personal datasets or unrelated files.
- Capture: register_component with package_into_library, origin_project (and original_paths when capturing a separated copy), capabilities, inputs, outputs, dependencies, documentation (how another project uses it) and a test command. Then run_component_tests, then create_release (first version 1.0.0). Each asks the user to approve.
- The source project is the origin, not a user: never link_component it unless it actually switches to the released copy. If it is not registered, offer register_project.

Projects and components: link_component only records that a project uses a component (shown as "Recorded"). It copies no code and proves nothing. get_project shows each link's integration: "added" (the release was copied unchanged into the project's components/<slug>/ by the browser's Add component), "connected" (the project's tests ran in the sandbox and called the component), or "" (recorded only). Never describe a recorded or added component as working in a project.

run_component_tests runs a stored shell command. Only call it when the user asks for tests to be run.

Versions: every released version is a read-only copy under its release path; use that path for the version a project uses, not the development folder. get_project and get_component show each project's recorded version, the latest release, and upgradeAvailable. Nothing upgrades a project automatically. To advise on an upgrade, call compare_versions and explain the change notes; only set_project_version changes the recorded version, and only after the user agrees.`;

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true });

export function buildServer(lib: Library, opts: { cwd?: string } = {}) {
  const server = new McpServer(
    { name: "component-library", version: "0.2.0" },
    { instructions: INSTRUCTIONS },
  );

  /** Runs a tool body, turning service errors into readable tool errors. */
  const guard = <A>(fn: (args: A) => Promise<ReturnType<typeof json>> | ReturnType<typeof json>) => async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      if (isLibraryError(err)) return fail(`${err.message} [${err.code}]`);
      console.error("[component-library mcp]", err);
      return fail(`Unexpected failure: ${(err as Error).message}`);
    }
  };

  /** Shows the change to the person and waits. Only an explicit "approve" proceeds. */
  async function approve(summary: string): Promise<string | null> {
    if (!server.server.getClientCapabilities()?.elicitation)
      return "No change was made. This MCP client cannot show an approval prompt, and library changes require one.";
    try {
      const res = await server.server.elicitInput(
        {
          mode: "form",
          message: summary,
          requestedSchema: {
            type: "object",
            properties: { approve: { type: "boolean", title: "Approve this change", description: "Tick to allow it. Leave unticked to refuse." } },
            required: ["approve"],
          },
        },
        { timeout: 15 * 60 * 1000 },
      );
      if (res.action === "accept" && res.content?.approve === true) return null;
      return `No change was made. The user ${res.action === "accept" ? "did not tick approve" : res.action === "decline" ? "declined" : "cancelled"} the approval prompt.`;
    } catch (err) {
      return `No change was made. The approval prompt failed: ${(err as Error).message}`;
    }
  }

  const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

  // ---------------- read-only discovery ----------------

  /** The project a request is about: the one named, or the registered
   * project whose folder this server was started in. */
  const projectFor = (named?: string): { ref: string; source: "argument" | "working directory" } | null => {
    if (named) return { ref: named, source: "argument" };
    const cwd = opts.cwd;
    if (!cwd) return null;
    const p = lib.projects.list().find((x) => x.path === cwd);
    return p ? { ref: p.id, source: "working directory" } : null;
  };

  const explain = (m: FunctionalityMatch, project?: string) => {
    const ctx = lib.discovery.context(m, project);
    return {
      component: { slug: m.component.slug, name: m.component.name, summary: m.component.summary, category: m.component.categoryName, lastTestStatus: m.component.lastTestStatus },
      strength: m.strength,
      fit: m.fit,
      capability: m.capability,
      otherCapabilities: m.otherCapabilities,
      why: m.why,
      unmatched: m.unmatched,
      version: ctx.version,
      latestRelease: ctx.latestRelease,
      ...(ctx.usedByProject !== undefined ? { usedByThisProject: ctx.usedByProject } : {}),
      ...(ctx.capturedFromProject ? { capturedFromThisProject: "This project holds the original code it was captured from. It does not use the released copy unless it is linked." } : {}),
      inspect: {
        next: `get_component "${ctx.inspect.getComponent}" for the documentation (${ctx.inspect.documentationChars} characters), capabilities, dependencies and test results`,
        sources: ctx.inspect.sources,
        ...(ctx.latestRelease ? { releasePath: ctx.latestRelease.path } : {}),
      },
      // Kept for callers written before strength existed.
      score: m.score,
      matchedTerms: m.matchedTerms,
      matchedCapabilities: m.matchedCapabilities,
    };
  };

  server.registerTool("search_components", {
    title: "Search components",
    description: "Search the library by name, category, description, capability or plain-language description of a task. `components` lists every hit (ranked matches first, then literal word matches); `matches` explains the ranked ones with strength (strong / partial / related) and the capability that matched. Optionally limit to one category (slug or id).",
    inputSchema: { query: z.string().default(""), category: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
    annotations: ro,
  }, guard(({ query, category, limit }) => {
    const max = limit ?? 50;
    const literal = lib.components.search(query, { category, limit: max });
    if (!query.trim()) return json({ count: literal.length, components: literal });
    const found = lib.discovery.find(query, { limit: max, category: category ? lib.categories.get(category).slug : undefined });
    const ranked = found.results.filter((m) => m.strength !== "related").map((m) => m.component);
    const components = [...ranked, ...literal.filter((c) => !ranked.some((r) => r.id === c.id))].slice(0, max);
    return json({
      count: components.length,
      components,
      understood: found.query,
      matches: found.results.map((m) => ({ slug: m.component.slug, strength: m.strength, capability: m.capability?.name ?? null, why: m.why })),
    });
  }));

  server.registerTool("find_reusable_functionality", {
    title: "Find reusable functionality",
    description: "Describe what you need in plain words (e.g. 'figure out what software a website uses'). Understands synonyms, vendor names, small misspellings, and the job asked for (detecting a tool is not the same as building one). Returns `matches` (strong: does it; partial: covers part, see `unmatched`) and, separately, `related` components that share the subject but do a different job and must not be presented as solutions. Each says which capability matched, why, the version, whether the given project (or the registered project in the current folder) already uses it, and where to read its documentation and source. Pass `project` (path or id) for project context.",
    inputSchema: {
      description: z.string().min(1),
      limit: z.number().int().min(1).max(50).optional(),
      project: z.string().optional().describe("Project path or id, to say whether it already uses each match."),
    },
    annotations: ro,
  }, guard(({ description, limit, project }) => {
    const found = lib.discovery.find(description, { limit: limit ?? 10 });
    const proj = projectFor(project);
    const shown = found.results.filter((m) => m.strength !== "related");
    const related = found.results.filter((m) => m.strength === "related");
    const strong = shown.filter((m) => m.strength === "strong").length;
    return json({
      count: shown.length,
      understood: found.query,
      ...(proj ? { projectContext: { project: lib.projects.get(proj.ref).name, from: proj.source } } : {}),
      note: strong
        ? "Strong matches already do this. Call get_component to read the documentation before recommending reuse, and say whether it fully or partially fits."
        : shown.length
          ? "Only partial matches: each covers part of the request (see unmatched). Read it with get_component; building the missing part, or something new, may still be right."
          : related.length
            ? "Nothing in the library does this. The related components share the subject but do a different job; they are not solutions."
            : "Nothing in the library matches this request.",
      matches: shown.map((m) => explain(m, proj?.ref)),
      related: related.map((m) => explain(m, proj?.ref)),
    });
  }));

  server.registerTool("check_for_duplicates", {
    title: "Check for duplicates",
    description: "Before proposing a new component, check whether the library already has it. `verdict`: exact (same name, or a capability already does this), partial (something covers part of it), related (same subject, different job; could be extended), or none. A partial or related verdict does not forbid building something new; it is there to inform the decision. `advice` says what to do next.",
    inputSchema: { name: z.string().min(1), summary: z.string().optional(), capabilities: z.array(z.string()).optional() },
    annotations: ro,
  }, guard((input) => {
    const r = lib.components.findDuplicates(input);
    return json({ ...r, similar: r.similar.map((m) => explain(m)) });
  }));

  server.registerTool("propose_capture", {
    title: "Propose capturing code as a component",
    description: "Read-only. Before capturing code from a project into the library, gather the facts for the proposal: duplicates already in the library, exactly which files would be copied and which excluded (secrets, dependencies, data), lines that look like credentials, imports that reach outside the copied files (what must be separated), configuration it reads, tests, dependency manifests and imports, the source project, the destination, and signals that it is too small or too tied to its app. Changes nothing. Show the proposal to the user and get agreement before register_component.",
    inputSchema: {
      name: z.string().min(1),
      sources: z.array(z.string().min(1)).min(1).describe("Absolute paths: the original code, or a separated copy in ~/.component-library/staging/<slug>/."),
      slug: z.string().optional(),
      category: z.string().optional().describe("Existing category slug or name."),
      summary: z.string().optional(),
      capabilities: z.array(z.string()).optional(),
      project: z.string().optional().describe("Source project id or path. Found from the source paths when omitted."),
    },
    annotations: ro,
  }, guard((req) => {
    const p = lib.capture.propose(req);
    return json({ ...p, duplicates: { ...p.duplicates, similar: p.duplicates.similar.map((m) => explain(m)) } });
  }));

  server.registerTool("list_categories", {
    title: "List categories",
    description: "List categories with component counts. Optional query filters by name/description.",
    inputSchema: { query: z.string().optional() },
    annotations: ro,
  }, guard(({ query }) => json(lib.categories.list(query))));

  server.registerTool("get_category", {
    title: "Browse a category",
    description: "A category (slug or id) and the components in it.",
    inputSchema: { category: z.string().min(1) },
    annotations: ro,
  }, guard(({ category }) => {
    const cat = lib.categories.get(category);
    return json({ category: cat, components: lib.components.search("", { category: cat.id, limit: 1000 }) });
  }));

  server.registerTool("get_component", {
    title: "Get component details",
    description: "Full details of one component (slug or id): source paths and whether each exists on disk now, capabilities and checks, inputs, outputs, dependencies, documentation, test command, the projects using it, and recent real test runs.",
    inputSchema: { component: z.string().min(1), full_test_output: z.boolean().optional().describe("Include complete stdout/stderr instead of the last 2,000 characters.") },
    annotations: ro,
  }, guard(({ component, full_test_output }) => {
    const c = lib.components.get(component);
    const tail = (s: string) => (full_test_output || s.length <= 2000 ? s : `…${s.slice(-2000)}`);
    const runs = lib.tests.list(c.id, 5).map((r) => ({ ...r, stdout: tail(r.stdout), stderr: tail(r.stderr) }));
    const releases = lib.releases.list(c.id).map((r) => ({ ...r, ...lib.releases.verify(c.id, r.version), recorded: undefined }));
    return json({
      ...c,
      releases,
      latestVersion: releases[0]?.version ?? null,
      testRuns: runs,
      testEvidence: runs.length ? `Latest run: ${runs[0].status} at ${runs[0].startedAt}.` : "No test has ever been run. Test status is unknown.",
    });
  }));

  server.registerTool("list_projects", {
    title: "List projects",
    description: "Registered project folders and how many library components each uses.",
    inputSchema: {},
    annotations: ro,
  }, guard(() => json(lib.projects.list())));

  server.registerTool("get_project", {
    title: "Get project",
    description: "One project (id or its exact absolute folder path) with the components it uses. Use the current working directory's absolute path to look up the current project.",
    inputSchema: { project: z.string().min(1) },
    annotations: ro,
  }, guard(({ project }) => json(lib.projects.get(project))));

  // ---------------- changes (each one asks the user) ----------------

  const ioItem = z.object({ name: z.string(), type: z.string().optional(), description: z.string().optional() });
  const capItem = z.object({ name: z.string(), description: z.string().optional(), kind: z.enum(["capability", "check"]).optional() });
  const depItem = z.object({ type: z.enum(["package", "component", "system"]), name: z.string(), version: z.string().optional() });
  const componentFields = {
    summary: z.string().optional().describe("One-line description."),
    documentation: z.string().optional(),
    language: z.string().optional(),
    version: z.string().optional(),
    capabilities: z.array(capItem).optional(),
    inputs: z.array(ioItem).optional(),
    outputs: z.array(ioItem).optional(),
    dependencies: z.array(depItem).optional(),
    test_command: z.string().optional().describe("Shell command that runs this component's tests. Stored only; never run automatically."),
    test_cwd: z.string().optional().describe("Absolute folder to run tests in. Blank = primary source folder."),
  };
  const toInput = (a: Record<string, any>): Partial<ComponentInput> => {
    const out: Partial<ComponentInput> = {
      name: a.name, slug: a.slug, category: a.category, summary: a.summary, documentation: a.documentation,
      language: a.language, version: a.version, sources: a.sources, capabilities: a.capabilities, inputs: a.inputs,
      outputs: a.outputs, dependencies: a.dependencies, testCommand: a.test_command, testCwd: a.test_cwd,
    };
    for (const k of Object.keys(out) as (keyof ComponentInput)[]) if (out[k] === undefined) delete out[k];
    return out;
  };
  const listLines = (label: string, items?: { name: string }[]) => (items?.length ? `${label}: ${items.map((i) => i.name).join(", ")}` : "");

  server.registerTool("create_category", {
    title: "Create category",
    description: "Create a category. Asks the user to approve first.",
    inputSchema: { name: z.string().min(1), description: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, guard(async ({ name, description }) => {
    const refused = await approve(`Create library category "${name}"${description ? `: ${description}` : ""}?`);
    if (refused) return fail(refused);
    return json({ created: lib.categories.create({ name, description }) });
  }));

  server.registerTool("register_component", {
    title: "Register component",
    description: "Add a component that points at real, existing source files or folders. Set package_into_library to copy the sources into the shared code folder first (originals are only read; secrets, data and build output are left out, and credential-looking text blocks the copy). When capturing from a project, run propose_capture first, get the user's agreement in chat, and pass origin_project. Asks the user to approve.",
    inputSchema: {
      name: z.string().min(1),
      category: z.string().min(1).describe("Existing category slug or id."),
      sources: z.array(z.string().min(1)).min(1).describe("Absolute paths that exist. First is primary."),
      slug: z.string().optional(),
      package_into_library: z.boolean().default(false),
      origin_project: z.string().optional().describe("When capturing from a project: its id or path. Records where the code came from; this is not a record that the project uses it."),
      original_paths: z.array(z.string().min(1)).optional().describe("When the sources are a separated copy: the original files in origin_project. Defaults to the sources."),
      ...componentFields,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, guard(async (args) => {
    const input = toInput(args) as ComponentInput;
    // Validate before asking, so the user is never asked to approve something that cannot happen.
    const category = lib.categories.get(input.category);
    const sources = input.sources.map((s) => lib.paths.check(s));
    if (input.testCwd) lib.paths.check(input.testCwd, "directory");
    const dupes = lib.components.findDuplicates({ name: input.name, summary: input.summary, capabilities: input.capabilities?.map((c) => c.name) });
    if (dupes.exact.length) return fail(`A component with this name or slug already exists: ${dupes.exact.map((c) => c.slug).join(", ")}. Update it instead.`);
    const slug = input.slug?.trim() || slugify(input.name);
    if (lib.components.search("", { limit: 1000 }).some((c) => c.slug === slug)) return fail(`The slug "${slug}" is already used. Pass a different slug.`);
    const target = path.join(lib.paths.libraryCodeDir(), slug);
    if (args.package_into_library && fs.existsSync(target)) return fail(`The shared folder ${target} already exists, so nothing was copied. Pass a different slug.`);
    const origin = args.origin_project || args.original_paths?.length ? { project: args.origin_project, paths: args.original_paths } : undefined;
    if (origin && !args.package_into_library) return fail("origin_project and original_paths are for captures: pass package_into_library too.");
    const originProject = origin?.project ? lib.projects.get(origin.project) : null;
    // A capture shows what will actually be copied, and refuses credentials before asking.
    const plan = args.package_into_library ? lib.capture.propose({ name: input.name, slug, sources: input.sources, project: originProject?.id }) : null;
    if (plan?.files.secrets.length) return fail(`Nothing was copied: ${plan.files.secrets.length} line(s) look like credentials: ${plan.files.secrets.slice(0, 5).map((f) => `${f.file}:${f.line} (${f.label})`).join("; ")}. Remove them first.`);

    // Claude Code folds long prompts after a few lines, so the essentials come first.
    const more = sources.length > 1 ? ` (+${sources.length - 1} more)` : "";
    const lines = [
      `Register "${input.name}" in "${category.name}" from ${sources[0].path}${more}${args.package_into_library ? ", copying it into the shared folder" : ""}?`,
      dupes.similar.length ? `Possibly similar, already in library: ${dupes.similar.map((m) => m.component.name).join(", ")}` : "No similar components found.",
      input.testCommand ? `Test command (stored, not run): ${input.testCommand}` : "",
      input.summary ? `Description: ${input.summary}` : "",
      `Sources:\n${sources.map((s) => `  ${s.path} (${s.kind})`).join("\n")}`,
      plan ? `${plan.files.count} file(s) will be COPIED into ${target}. Originals are only read, never changed.${plan.files.excluded.length ? ` Left out: ${plan.files.excluded.map((e) => e.path).slice(0, 8).join(", ")}${plan.files.excluded.length > 8 ? ", …" : ""}.` : ""}` : "Sources stay where they are; the library only records their paths.",
      origin ? `Captured from: ${originProject ? `project "${originProject.name}"` : "an unregistered folder"} (${(origin.paths ?? input.sources).join(", ")}). Recorded as where it came from, not as a project using it.` : "",
      listLines("Capabilities", input.capabilities),
      listLines("Dependencies", input.dependencies),
    ];
    const refused = await approve(lines.filter(Boolean).join("\n"));
    if (refused) return fail(refused);
    if (args.package_into_library) {
      const { component, packaged } = lib.components.createPackaged(input, origin);
      return json({ registered: component, packaged });
    }
    return json({ registered: lib.components.create(input) });
  }));

  server.registerTool("update_component", {
    title: "Update component",
    description: "Change fields of an existing component (slug or id). Only fields you pass change; a list you pass REPLACES the old list (use add_capability to add one capability). Asks the user to approve.",
    inputSchema: {
      component: z.string().min(1),
      name: z.string().optional(),
      slug: z.string().optional(),
      category: z.string().optional(),
      sources: z.array(z.string().min(1)).min(1).optional(),
      ...componentFields,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, guard(async ({ component, ...rest }) => {
    const cur = lib.components.get(component);
    const patch = toInput(rest);
    if (!Object.keys(patch).length) return fail("Nothing to change: pass at least one field.");
    if (patch.category) lib.categories.get(patch.category);
    patch.sources?.forEach((s) => lib.paths.check(s));
    if (patch.testCwd) lib.paths.check(patch.testCwd, "directory");
    const show = (v: unknown) => (Array.isArray(v) ? v.map((x: any) => (typeof x === "string" ? x : x.name)).join(", ") || "(empty)" : String(v ?? "") || "(empty)");
    const before: Record<string, unknown> = {
      name: cur.name, slug: cur.slug, category: cur.categoryName, summary: cur.summary, documentation: cur.documentation,
      language: cur.language, version: cur.version, sources: cur.sources.map((s) => s.path), capabilities: cur.capabilities,
      inputs: cur.inputs, outputs: cur.outputs, dependencies: cur.dependencies, testCommand: cur.testCommand, testCwd: cur.testCwd,
    };
    const diff = Object.entries(patch).map(([k, v]) => `  ${k}: ${show(before[k]).slice(0, 200)}  →  ${show(v).slice(0, 200)}`);
    const refused = await approve(`Update component "${cur.name}" (${cur.slug})?\n${diff.join("\n")}${patch.testCommand ? "\nThe test command is stored, not run." : ""}`);
    if (refused) return fail(refused);
    return json({ updated: lib.components.update(cur.id, patch) });
  }));

  server.registerTool("add_capability", {
    title: "Add capability or check",
    description: "Add one capability (something it does) or check (something it verifies) to an existing component, leaving the rest untouched. Asks the user to approve.",
    inputSchema: { component: z.string().min(1), name: z.string().min(1), description: z.string().optional(), kind: z.enum(["capability", "check"]).default("capability") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, guard(async ({ component, name, description, kind }) => {
    const c = lib.components.get(component);
    if (c.capabilities.some((x) => x.name.toLowerCase() === name.trim().toLowerCase()))
      return fail(`"${c.name}" already has a capability or check called "${name}".`);
    const refused = await approve(`Add ${kind} "${name}" to "${c.name}"?${description ? `\n${description}` : ""}`);
    if (refused) return fail(refused);
    return json({ updated: lib.components.addCapability(c.id, { name, description, kind }) });
  }));

  server.registerTool("register_project", {
    title: "Register project folder",
    description: "Record an existing project folder (absolute path) so components can be linked to it. Nothing in the folder is read or changed. Asks the user to approve.",
    inputSchema: { path: z.string().min(1), name: z.string().optional(), description: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, guard(async ({ path, name, description }) => {
    const checked = lib.paths.check(path, "directory");
    const refused = await approve(`Register project folder ${checked.path}${name ? ` as "${name}"` : ""}? (The folder itself is not changed.)`);
    if (refused) return fail(refused);
    return json({ registered: lib.projects.register({ path: checked.path, name, description }) });
  }));

  server.registerTool("link_component", {
    title: "Link component to project",
    description: "Record that a project (id or exact folder path) uses a component (slug or id), at a version. The version defaults to the newest release; pass an older release to record that instead. Library record only; the project folder is not changed. Asks the user to approve.",
    inputSchema: { project: z.string().min(1), component: z.string().min(1), note: z.string().optional(), version: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, guard(async ({ project, component, note, version }) => {
    const p = lib.projects.get(project);
    const c = lib.components.get(component);
    if (p.components.some((x) => x.componentId === c.id)) return fail(`"${p.name}" already uses "${c.name}".`);
    const released = c.releasedVersions;
    if (version && released.length && !released.includes(version.trim()))
      return fail(`${version} is not a recorded release of "${c.name}". Recorded: ${released.join(", ")}.`);
    const v = version?.trim() || released[0] || c.version || "";
    const isOrigin = c.origin?.project?.id === p.id;
    const refused = await approve(`Record that project "${p.name}" uses "${c.name}"${v ? ` ${v}` : ""}?${note ? `\nNote: ${note}` : ""}` +
      (isOrigin ? `\n"${p.name}" is where this code was captured from. Approve only if it now runs the released copy.` : ""));
    if (refused) return fail(refused);
    return json({ project: lib.projects.link(p.id, c.id, note, version) });
  }));

  server.registerTool("unlink_component", {
    title: "Unlink component from project",
    description: "Remove the record that a project uses a component. Files are not touched. Asks the user to approve.",
    inputSchema: { project: z.string().min(1), component: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, guard(async ({ project, component }) => {
    const p = lib.projects.get(project);
    const c = lib.components.get(component);
    if (!p.components.some((x) => x.componentId === c.id)) return fail(`"${p.name}" does not use "${c.name}".`);
    const refused = await approve(`Remove the record that "${p.name}" uses "${c.name}"?`);
    if (refused) return fail(refused);
    return json({ project: lib.projects.unlink(p.id, c.id) });
  }));

  server.registerTool("compare_versions", {
    title: "Compare versions",
    description: "What changed in a component between two released versions (from = the version a project uses; to defaults to the latest). Returns each release's change notes, oldest first, plus whether the jump is a major version (possibly breaking). Use it to explain an upgrade.",
    inputSchema: { component: z.string().min(1), from: z.string().min(1), to: z.string().optional() },
    annotations: ro,
  }, guard(({ component, from, to }) => {
    const c = lib.components.get(component);
    const steps = lib.releases.changesBetween(c.id, from, to);
    const target = to ?? lib.releases.list(c.id)[0]?.version ?? from;
    const major = (v: string) => Number(v.split(".")[0]);
    return json({
      component: c.slug, from, to: target,
      upToDate: steps.length === 0,
      majorChange: major(target) > major(from),
      note: major(target) > major(from)
        ? "A major version change: existing behaviour may have changed. Read every note before upgrading."
        : "Same major version: by semantic versioning, existing behaviour should still work. Read the notes for anything to watch.",
      releases: steps.map((r) => ({ version: r.version, releasedAt: r.releasedAt, sourcePath: r.sourcePath, changes: r.changes })),
    });
  }));

  server.registerTool("verify_release", {
    title: "Verify release files",
    description: "Recompute a release's checksum and compare it with the recorded one: intact, changed, or missing.",
    inputSchema: { component: z.string().min(1), version: z.string().min(1) },
    annotations: ro,
  }, guard(({ component, version }) => json(lib.releases.verify(component, version))));

  server.registerTool("record_release", {
    title: "Record a release",
    description: "Record a released version of a component: a version newer than the last release, the path of its frozen release folder (made by scripts/release.ts), and change notes. Sets the component's version. Never changes the version any project uses. Asks the user to approve.",
    inputSchema: { component: z.string().min(1), version: z.string().min(1), path: z.string().min(1), changes: z.string().min(1), git_tag: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, guard(async ({ component, version, path: dir, changes, git_tag }) => {
    const c = lib.components.get(component);
    const checked = lib.paths.check(dir, "directory");
    const latest = c.releasedVersions[0];
    const using = c.projects.length;
    const refused = await approve(
      `Record ${c.name} ${version} from ${checked.path}?${latest ? ` Latest release now: ${latest}.` : " First recorded release."}\n` +
      `${using ? `${using} project(s) use it; they stay on their recorded version.` : "No project uses it yet."}\n` +
      `Changes: ${changes.slice(0, 600)}`,
    );
    if (refused) return fail(refused);
    return json({ recorded: lib.releases.record(c.id, { version, path: checked.path, changes, gitTag: git_tag }) });
  }));

  server.registerTool("create_release", {
    title: "Create a release",
    description: "Freeze a component's folder as a new version and record it, in one step: copies it to library/releases/<slug>/<version>/, writes RELEASE.json with every file's checksum, makes it read-only, and records the change notes. Only when the latest test run passed and no file changed since. Never overwrites a release and never changes the version any project uses. Asks the user to approve.",
    inputSchema: { component: z.string().min(1), version: z.string().min(1), changes: z.string().min(1), git_tag: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, guard(async ({ component, version, changes, git_tag }) => {
    const c = lib.components.get(component);
    const ready = lib.releases.readiness(c.id);
    if (!ready.ready) return fail(`Not released: ${ready.problems.join(" ")}`);
    const latest = c.releasedVersions[0];
    const dest = path.join(lib.releases.dir(), c.slug, version.trim());
    if (fs.existsSync(dest)) return fail(`${dest} already exists. Releases are never overwritten.`);
    const refused = await approve(
      `Release ${c.name} ${version} from ${ready.from}?${latest ? ` Latest release now: ${latest}.` : " First release."}\n` +
      `Tests passed at ${ready.lastRun!.startedAt}; no file changed since. The copy goes to ${dest} and becomes read-only.\n` +
      `${c.projects.length ? `${c.projects.length} project(s) use it; they stay on their recorded version.` : "No project uses it yet."}\n` +
      `Changes: ${changes.slice(0, 600)}`,
    );
    if (refused) return fail(refused);
    return json(lib.releases.create(c.id, { version, changes, gitTag: git_tag }));
  }));

  server.registerTool("set_project_version", {
    title: "Set a project's component version",
    description: "Change which released version of a component a project is recorded as using (an upgrade or a rollback). This is the only way that version changes. Only call after the user agrees to the change. Records only; the project's files are not changed. Asks the user to approve.",
    inputSchema: { project: z.string().min(1), component: z.string().min(1), version: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, guard(async ({ project, component, version }) => {
    const p = lib.projects.get(project);
    const c = lib.components.get(component);
    const link = p.components.find((x) => x.componentId === c.id);
    if (!link) return fail(`"${p.name}" does not use "${c.name}".`);
    if (c.releasedVersions.length && !c.releasedVersions.includes(version.trim()))
      return fail(`${version} is not a recorded release of "${c.name}". Recorded: ${c.releasedVersions.join(", ")}.`);
    if (link.version === version.trim()) return fail(`"${p.name}" is already recorded at ${version}.`);
    const refused = await approve(`Change "${p.name}" from ${c.name} ${link.version || "(unrecorded)"} to ${version}? This updates the library record only; the project's code is not changed.`);
    if (refused) return fail(refused);
    return json({ project: lib.projects.setVersion(p.id, c.id, version) });
  }));

  server.registerTool("unregister_project", {
    title: "Unregister project",
    description: "Remove a project and its component links from the library. The folder on disk is not touched. Asks the user to approve.",
    inputSchema: { project: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, guard(async ({ project }) => {
    const p = lib.projects.get(project);
    const refused = await approve(`Remove project "${p.name}" (${p.path}) and its ${p.components.length} component link(s) from the library? The folder is not touched.`);
    if (refused) return fail(refused);
    return json(lib.projects.unregister(p.id));
  }));

  server.registerTool("run_component_tests", {
    title: "Run component tests",
    description: "Run a component's stored test command as a shell command and return the real exit code and output. Only call when the user asks. Shows the exact command and asks the user to approve.",
    inputSchema: { component: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, guard(async ({ component }) => {
    const c: ComponentDetail = lib.components.get(component);
    if (!c.testCommand.trim()) return fail(`"${c.name}" has no test command, so nothing was run. Test status is unknown.`);
    const cwd = lib.tests.resolveCwd(c.id);
    const refused = await approve(
      `Run this shell command on your Mac?\n\n  ${c.testCommand}\n\nin ${cwd}\n\nIt comes from the "${c.name}" library record. It runs with your user's permissions and can do anything a terminal command can. Approve only if you trust it.`,
    );
    if (refused) return fail(refused);
    const run = await lib.tests.run(c.id);
    return json({ ...run, summary: `${run.status} (exit ${run.exitCode ?? "none"}) in ${(run.durationMs / 1000).toFixed(1)}s` });
  }));

  return server;
}
