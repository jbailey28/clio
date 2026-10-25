/**
 * Text-box formats used by the browser forms. These only translate text to the
 * service layer's plain objects and back; no rules live here.
 */
import type { ComponentDetail, ComponentInput } from "@/src/core";

const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

const splitDesc = (line: string): [string, string] => {
  const i = line.indexOf("::");
  return i === -1 ? [line.trim(), ""] : [line.slice(0, i).trim(), line.slice(i + 2).trim()];
};

/** "Name :: description", or "check: Name :: description" for a check. */
export function parseCapabilities(text: string): NonNullable<ComponentInput["capabilities"]> {
  return lines(text).map((l) => {
    const isCheck = /^check:\s*/i.test(l);
    const [name, description] = splitDesc(l.replace(/^(check|capability):\s*/i, ""));
    return { name, description, kind: isCheck ? "check" : "capability" };
  });
}

/** "name (type) :: description" */
export function parseIO(text: string): { name: string; type: string; description: string }[] {
  return lines(text).map((l) => {
    const [head, description] = splitDesc(l);
    const m = head.match(/^(.*?)\s*\((.*)\)\s*$/);
    return m ? { name: m[1].trim(), type: m[2].trim(), description } : { name: head, type: "", description };
  });
}

/** "pkg@version", "component: slug", or "system: tool". */
export function parseDependencies(text: string): NonNullable<ComponentInput["dependencies"]> {
  return lines(text).map((l) => {
    const m = l.match(/^(package|component|system):\s*(.+)$/i);
    const type = (m ? m[1].toLowerCase() : "package") as "package" | "component" | "system";
    const rest = (m ? m[2] : l).trim();
    if (type !== "package") return { type, name: rest, version: "" };
    const at = rest.lastIndexOf("@");
    return at > 0 ? { type, name: rest.slice(0, at), version: rest.slice(at + 1) } : { type, name: rest, version: "" };
  });
}

export const parseLines = lines;

export function formatCapabilities(c: ComponentDetail): string {
  return c.capabilities.map((x) => `${x.kind === "check" ? "check: " : ""}${x.name}${x.description ? ` :: ${x.description}` : ""}`).join("\n");
}

export function formatIO(items: ComponentDetail["inputs"]): string {
  return items.map((x) => `${x.name}${x.type ? ` (${x.type})` : ""}${x.description ? ` :: ${x.description}` : ""}`).join("\n");
}

export function formatDependencies(c: ComponentDetail): string {
  return c.dependencies
    .map((d) => (d.type === "package" ? `${d.name}${d.version ? `@${d.version}` : ""}` : `${d.type}: ${d.name}`))
    .join("\n");
}

/** Reads the component form into a service-layer input. */
export function componentFromForm(f: FormData): Partial<ComponentInput> {
  const s = (k: string) => (f.has(k) ? String(f.get(k) ?? "") : undefined);
  const out: Partial<ComponentInput> = {
    name: s("name"),
    slug: s("slug"),
    category: s("category"),
    summary: s("summary"),
    documentation: s("documentation"),
    language: s("language"),
    version: s("version"),
    testCommand: s("testCommand"),
    testCwd: s("testCwd"),
  };
  if (f.has("sources")) out.sources = lines(String(f.get("sources")));
  if (f.has("capabilities")) out.capabilities = parseCapabilities(String(f.get("capabilities")));
  if (f.has("inputs")) out.inputs = parseIO(String(f.get("inputs")));
  if (f.has("outputs")) out.outputs = parseIO(String(f.get("outputs")));
  if (f.has("dependencies")) out.dependencies = parseDependencies(String(f.get("dependencies")));
  for (const k of Object.keys(out) as (keyof ComponentInput)[]) if (out[k] === undefined) delete out[k];
  return out;
}
