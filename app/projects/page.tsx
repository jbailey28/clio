import Link from "next/link";
import { getLib } from "@/src/web/lib";
import { SearchField, SortSelect } from "@/src/ui/client";
import { Ago, Empty, Flash, PageHead, plural, type SP } from "@/src/ui/server";
import { ChevronRight, Folder, I, Plus } from "@/src/ui/icons";
import type { ProjectSort } from "@/src/core";

export const dynamic = "force-dynamic";

const SORTS: { value: ProjectSort; label: string }[] = [
  { value: "changed", label: "Last updated" },
  { value: "name", label: "Name" },
  { value: "added", label: "Date added" },
];

export default async function Projects({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const sort = (SORTS.some((s) => s.value === sp.sort) ? sp.sort : "changed") as ProjectSort;
  const all = getLib().projects.list(sort);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const projects = all.filter((p) => words.every((w) => `${p.name} ${p.description} ${p.path}`.toLowerCase().includes(w)));
  return (
    <>
      <PageHead title="My Projects" subtitle="The project folders that use components from the library."
        actions={<Link href="/projects/new" className="button"><I icon={Plus} size={18} /> Add project</Link>} />
      <Flash sp={sp} />
      {all.length > 0 && (
        <form action="/projects" method="get" role="search" className="toolbar compact">
          <div className="grow"><SearchField defaultValue={q} label="Search projects" placeholder="Search projects..." compact /></div>
          <SortSelect value={sort} options={SORTS} />
        </form>
      )}
      {projects.length ? (
        <ul className="rows">
          {projects.map((p) => (
            <li key={p.id}>
              <Link href={`/projects/${p.id}`} className="row-link">
                <span className="tile sm"><I icon={Folder} size={18} /></span>
                <span className="body">
                  <strong>{p.name}</strong>
                  {p.pathStatus === "missing" && <> <span className="badge missing">folder not found now</span></>}
                  <div className="desc">{p.description || <code>{p.path}</code>}</div>
                </span>
                <span className="meta">{plural(p.componentCount, "component")}</span>
                <span className="meta"><Ago iso={p.lastChangedAt} prefix="Updated " /></span>
                <I icon={ChevronRight} className="muted" />
              </Link>
            </li>
          ))}
        </ul>
      ) : all.length ? (
        <Empty title={`No projects match “${q}”.`} />
      ) : (
        <Empty title="No projects yet.">
          <p><Link href="/projects/new">Add a project</Link>: create a new one, or connect one that's already on your Mac.</p>
        </Empty>
      )}
    </>
  );
}
