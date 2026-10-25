import type { Category, ComponentDetail } from "@/src/core";
import { formatCapabilities, formatDependencies, formatIO } from "@/src/web/forms";

/** The fields shared by "Add existing component" and "Configuration". */
export function ComponentFields({ categories, c, defaultCategory }: { categories: Category[]; c?: ComponentDetail; defaultCategory?: string }) {
  return (
    <>
      <div className="row">
        <label>Name<input name="name" defaultValue={c?.name} required /></label>
        {c && <label>Slug (how Claude Code refers to it)<input name="slug" defaultValue={c.slug} /></label>}
        <label>
          Category
          <select name="category" defaultValue={c?.categoryId ?? defaultCategory ?? ""} required>
            <option value="" disabled>Choose a category</option>
            {categories.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
        </label>
      </div>
      <label>Description<input name="summary" defaultValue={c?.summary} placeholder="What it does, in one line" /></label>
      <div className="row">
        <label>Language<input name="language" defaultValue={c?.language} placeholder="TypeScript" /></label>
        <label>Version<input name="version" defaultValue={c?.version} placeholder="1.0.0" /></label>
      </div>
      <label>
        Source paths (one per line, first is primary; must exist)
        <textarea name="sources" required defaultValue={c?.sources.map((s) => s.path).join("\n")} placeholder="~/code/shared/retry" />
      </label>
      <label>
        Capabilities and checks (one per line: <code>Name :: description</code>, prefix <code>check:</code> for a check)
        <textarea name="capabilities" defaultValue={c ? formatCapabilities(c) : ""} />
      </label>
      <div className="row">
        <label>
          Inputs (<code>name (type) :: description</code>)
          <textarea name="inputs" defaultValue={c ? formatIO(c.inputs) : ""} />
        </label>
        <label>
          Outputs (<code>name (type) :: description</code>)
          <textarea name="outputs" defaultValue={c ? formatIO(c.outputs) : ""} />
        </label>
      </div>
      <label>
        Dependencies (<code>package@version</code>, <code>component: slug</code>, or <code>system: tool</code>)
        <textarea name="dependencies" defaultValue={c ? formatDependencies(c) : ""} />
      </label>
      <div className="row">
        <label>Test command (runs in a shell)<input name="testCommand" defaultValue={c?.testCommand} placeholder="npm test" /></label>
        <label>Test folder (blank = primary source folder)<input name="testCwd" defaultValue={c?.testCwd} /></label>
      </div>
      <label>Documentation<textarea name="documentation" defaultValue={c?.documentation} style={{ minHeight: 140 }} /></label>
    </>
  );
}
