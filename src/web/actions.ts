import "server-only";
import { invalid } from "@/src/core/errors";
import { getLib } from "./lib";
import { componentFromForm, parseLines } from "./forms";
import type { ComponentInput } from "@/src/core";

/**
 * Every browser write goes through one of these. Each one reads the form,
 * calls the service layer, and says where to go next. No rules live here.
 */
type Op = (f: FormData) => string | Promise<string>;
const str = (f: FormData, k: string) => String(f.get(k) ?? "");
const json = (f: FormData, k: string) => {
  try { return JSON.parse(str(f, k)); } catch { throw invalid("The form sent something unreadable. Refresh and try again."); }
};
const enc = encodeURIComponent;

export const ops: Record<string, Op> = {
  "category.create": (f) => {
    const c = getLib().categories.create({ name: str(f, "name"), description: str(f, "description") });
    return `/categories/${c.slug}`;
  },
  "category.update": (f) => {
    const c = getLib().categories.update(str(f, "ref"), { name: str(f, "name"), description: str(f, "description") });
    return `/categories/${c.slug}?ok=${enc("Category saved")}`;
  },
  "category.delete": (f) => {
    getLib().categories.delete(str(f, "ref"));
    return `/categories?ok=${enc("Category deleted")}`;
  },

  "component.create": (f) => {
    const c = getLib().components.create(componentFromForm(f) as ComponentInput);
    return `/components/${c.slug}?ok=${enc("Component registered")}`;
  },
  "component.update": (f) => {
    const c = getLib().components.update(str(f, "ref"), componentFromForm(f));
    return `/components/${c.slug}?tab=configuration&ok=${enc("Changes saved")}`;
  },
  "component.delete": (f) => {
    const r = getLib().removal.removeComponent(str(f, "ref"), { confirm: str(f, "confirm"), trashFiles: str(f, "files") === "trash" });
    return `/categories/${r.category}?ok=${enc(r.trashed.length ? `Deleted "${r.name}". Its files in the library are in the Trash.` : `Deleted "${r.name}" from the library. Its files were not touched.`)}`;
  },
  "component.test": async (f) => {
    const lib = getLib();
    const run = await lib.tests.run(str(f, "ref"));
    const page = `/components/${lib.components.get(run.componentId).slug}?tab=tests`;
    return run.status === "passed" ? `${page}&ok=${enc("Tests passed.")}` : `${page}&error=${enc(`The tests ${run.status}. The output is below.`)}`;
  },

  "project.register": (f) => {
    const p = getLib().projects.register({ path: str(f, "path"), name: str(f, "name"), description: str(f, "description") });
    return `/projects/${p.id}?ok=${enc("Project added. Nothing in its folder was changed.")}`;
  },
  "project.update": (f) => {
    const p = getLib().projects.update(str(f, "ref"), { path: str(f, "path"), name: str(f, "name"), description: str(f, "description") });
    return withOk(str(f, "returnTo") || `/projects/${p.id}`, "Project saved");
  },
  "project.unregister": (f) => {
    const r = getLib().removal.removeProject(str(f, "ref"), { confirm: str(f, "confirm"), trashFolder: str(f, "folder") === "trash" });
    return `/projects?ok=${enc(r.trashed ? "Project removed. Its folder is in the Trash." : "Project removed from the library. Its folder was not touched.")}`;
  },
  "project.link": (f) => {
    getLib().projects.link(str(f, "project"), str(f, "component"), str(f, "note"), str(f, "version") || undefined);
    return withOk(str(f, "returnTo") || `/projects/${str(f, "project")}`, "Component added to project");
  },
  "project.setVersion": (f) => {
    getLib().projects.setVersion(str(f, "project"), str(f, "component"), str(f, "version"));
    return withOk(str(f, "returnTo") || `/projects/${str(f, "project")}`, "Version updated");
  },
  "project.unlink": (f) => {
    const r = getLib().removal.removeFromProject(str(f, "project"), str(f, "component"), { trashCopy: str(f, "copy") === "trash", confirm: str(f, "confirm") });
    return withOk(str(f, "returnTo") || `/projects/${str(f, "project")}`, r.trashed ? "Component removed from the project. Its copy is in the Trash." : "Component removed from the project");
  },

  "settings.update": (f) => {
    getLib().settings.update({
      allowedRoots: parseLines(str(f, "allowedRoots")),
      testTimeoutSeconds: Number(str(f, "testTimeoutSeconds")),
      ...(f.has("projectsRoot") ? { projectsRoot: str(f, "projectsRoot") } : {}),
    });
    return `/settings?ok=${enc("Settings saved")}`;
  },

  // ---- creating a project from a description ----
  "projectDraft.start": async (f) => {
    const d = await getLib().projectCreation.start(str(f, "prompt"));
    return `/projects/create/${d.id}`;
  },
  "projectDraft.retry": async (f) => {
    await getLib().projectCreation.replan(str(f, "draft"));
    return `/projects/create/${str(f, "draft")}?step=plan`;
  },
  // From Describe: plans again only if the description changed (or there's no plan yet).
  "projectDraft.replan": async (f) => {
    const lib = getLib();
    const id = str(f, "draft");
    const d = lib.projectCreation.get(id);
    const prompt = str(f, "prompt").trim();
    if (!d.plan || prompt !== d.prompt) await lib.projectCreation.replan(id, prompt);
    return `/projects/create/${id}?step=plan`;
  },
  "projectDraft.savePlan": (f) => {
    getLib().projectCreation.savePlan(str(f, "draft"), json(f, "plan"));
    return `/projects/create/${str(f, "draft")}?step=plan`;
  },
  "projectDraft.refine": async (f) => {
    const lib = getLib();
    if (f.has("plan")) lib.projectCreation.savePlan(str(f, "draft"), json(f, "plan")); // the person's latest edits first, so they are kept
    await lib.projectCreation.refine(str(f, "draft"), str(f, "instruction"));
    return `/projects/create/${str(f, "draft")}?step=plan`;
  },
  "projectDraft.undo": (f) => {
    getLib().projectCreation.undo(str(f, "draft"));
    return `/projects/create/${str(f, "draft")}?step=plan`;
  },
  "projectDraft.analyze": async (f) => {
    await getLib().projectCreation.analyze(str(f, "draft"));
    return `/projects/create/${str(f, "draft")}?step=components`;
  },
  "projectDraft.choose": (f) => {
    getLib().projectCreation.choose(str(f, "draft"), json(f, "choice"));
    return `/projects/create/${str(f, "draft")}?step=components`;
  },
  "projectDraft.folder": (f) => {
    getLib().projectCreation.folder(str(f, "draft"), str(f, "folder"));
    return `/projects/create/${str(f, "draft")}?step=build&ok=${enc("Folder name saved")}`;
  },
  "projectDraft.build": async (f) => {
    const lib = getLib();
    await lib.projectCreation.build(str(f, "draft"), str(f, "feedback"));
    const b = lib.projectCreation.get(str(f, "draft")).build!;
    const page = `/projects/create/${str(f, "draft")}?step=${str(f, "next") === "test" ? "test" : "build"}`;
    return b.problems.length ? `/projects/create/${str(f, "draft")}?step=build&error=${enc("The project was written, but the checks found problems, so it won't be run.")}` : page;
  },
  "projectDraft.test": async (f) => {
    await getLib().projectCreation.test(str(f, "draft"), str(f, "again") === "1");
    return `/projects/create/${str(f, "draft")}?step=test`;
  },
  "project.addComponent": (f) => {
    const lib = getLib();
    const r = lib.integration.add(str(f, "project"), str(f, "component"), str(f, "version"));
    return `/projects/${r.project.id}?tab=components&ok=${enc(`Added ${r.component.name} ${r.version} in components/${r.component.slug}/. Nothing else in the project was changed.`)}`;
  },
  "project.checkConnection": async (f) => {
    const lib = getLib();
    const r = await lib.integration.check(str(f, "project"), str(f, "component"));
    const page = `/projects/${str(f, "project")}?tab=components`;
    return r.integration === "connected" ? `${page}&ok=${enc(`Connected: ${r.detail}`)}` : `${page}&error=${enc(`Not connected yet: ${r.detail}`)}`;
  },
  "projectDraft.create": async (f) => {
    const lib = getLib();
    await lib.projectCreation.create(str(f, "draft"));
    const d = lib.projectCreation.get(str(f, "draft"));
    return `/projects/${d.project!.id}?ok=${enc(`Project created in ${d.project!.path} and added to the library.`)}`;
  },
  "projectDraft.discard": (f) => {
    getLib().projectCreation.discard(str(f, "draft"));
    return `/projects/create?ok=${enc("Plan discarded. No folder was created.")}`;
  },

  // ---- creating a component from a description: one button per step ----
  "create.start": async (f) => {
    const d = await getLib().creation.start(str(f, "prompt"));
    return `/create/${d.id}`;
  },
  "create.retry": async (f) => {
    await getLib().creation.retryProposal(str(f, "draft"));
    return `/create/${str(f, "draft")}?ok=${enc("The proposal is ready to review.")}`;
  },
  "create.answer": async (f) => {
    const answers = [...f.keys()].filter((k) => /^answer_\d+$/.test(k)).sort().map((k) => str(f, k));
    await getLib().creation.answer(str(f, "draft"), answers);
    return `/create/${str(f, "draft")}?ok=${enc("The proposal is ready to review.")}`;
  },
  "create.edit": (f) => {
    const patch: { name?: string; summary?: string; category?: string } = {};
    if (f.has("category")) patch.category = str(f, "category");
    if (f.has("name")) patch.name = str(f, "name");
    if (f.has("summary")) patch.summary = str(f, "summary");
    getLib().creation.edit(str(f, "draft"), patch);
    return `/create/${str(f, "draft")}?ok=${enc("Saved")}`;
  },
  "create.newCategory": (f) => {
    const lib = getLib();
    const c = lib.categories.create({ name: str(f, "name"), description: str(f, "description") });
    lib.creation.edit(str(f, "draft"), { category: c.slug });
    return `/create/${str(f, "draft")}?ok=${enc(`Created category "${c.name}" and chose it`)}`;
  },
  "create.generate": async (f) => {
    const lib = getLib();
    await lib.creation.generate(str(f, "draft"), str(f, "feedback"));
    const checks = lib.creation.get(str(f, "draft")).generation!.checks;
    return checks.ok
      ? `/create/${str(f, "draft")}?ok=${enc("Code generated and checked. Review the files, then run the tests.")}`
      : `/create/${str(f, "draft")}?error=${enc("The code was generated, but the safety checks found problems, so it won't be run. See below.")}`;
  },
  "create.test": async (f) => {
    const lib = getLib();
    await lib.creation.runTests(str(f, "draft"));
    const t = lib.creation.get(str(f, "draft")).tests!;
    return t.status === "passed"
      ? `/create/${str(f, "draft")}?ok=${enc("Tests passed.")}`
      : `/create/${str(f, "draft")}?error=${enc(`The tests ${t.status}. The output is below, and Fix can try again.`)}`;
  },
  "create.register": async (f) => {
    const lib = getLib();
    await lib.creation.register(str(f, "draft"));
    const slug = lib.creation.get(str(f, "draft")).component!.slug;
    return `/components/${slug}?ok=${enc("Added to the library and released as 1.0.0")}`;
  },
  "create.discard": (f) => {
    getLib().creation.discard(str(f, "draft"));
    return `/create?ok=${enc("Draft discarded. Nothing was added to the library.")}`;
  },
};

function withOk(url: string, msg: string) {
  const [p, q = ""] = url.split("?");
  const params = new URLSearchParams(q);
  params.delete("error");
  params.set("ok", msg);
  return `${p}?${params}`;
}

/** Only same-site relative paths, so a form can't redirect elsewhere. */
export function safeReturn(url: string, fallback = "/"): string {
  return url.startsWith("/") && !url.startsWith("//") && !url.includes("\\") ? url : fallback;
}
