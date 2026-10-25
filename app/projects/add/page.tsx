import Link from "next/link";
import { getLib } from "@/src/web/lib";
import { ActionForm } from "@/src/ui/client";
import { Empty, Flash, PageHead, type SP } from "@/src/ui/server";
import { ArrowLeft, ChevronRight, CircleAlert, Folder, FolderOpen, I } from "@/src/ui/icons";
import type { FolderListing, FolderSuggestion } from "@/src/core";

export const dynamic = "force-dynamic";

/**
 * Add existing project. The folder browser is plain links rendered here on
 * the server (a web page can't see real paths), limited to the allowed
 * folders. Choosing a folder reads its project file and README for
 * suggestions; adding it only records it in the library.
 */
export default async function AddExisting({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const lib = getLib();
  let listing: FolderListing | null = null;
  let suggestion: FolderSuggestion | null = null;
  let problem: string | null = null;
  try {
    if (sp.path) suggestion = lib.folders.inspect(sp.path);
    else listing = lib.folders.list(sp.browse);
  } catch (err) {
    problem = (err as Error).message;
    if (!listing) listing = lib.folders.list();
  }

  return (
    <>
      <Link href="/projects/new" className="crumb"><I icon={ArrowLeft} size={16} /> Add a project</Link>
      <PageHead title="Add existing project" subtitle="Connect a project folder that's already on your Mac. Nothing in it is changed." />
      <Flash sp={sp} />
      {problem && <p className="flash error" role="alert">{problem}</p>}
      {suggestion ? <Review s={suggestion} /> : <Browser l={listing!} />}
    </>
  );
}

function Browser({ l }: { l: FolderListing }) {
  return (
    <>
      <section className="card" aria-labelledby="browse-title">
        <h2 id="browse-title" className="panel-title">Choose a folder</h2>
        <div className="path-bar">
          {l.path ? <><I icon={FolderOpen} size={16} /> <code>{l.path}</code></> : "Your allowed folders"}
          {l.parent && <Link href={`/projects/add?browse=${encodeURIComponent(l.parent)}`}>Up one level</Link>}
          {l.path && !l.parent && <Link href="/projects/add">Back to allowed folders</Link>}
        </div>
        {l.path && (
          <p style={{ marginTop: 0 }}>
            {l.registeredAs
              ? <span className="muted">This folder is already in the library as “{l.registeredAs}”.</span>
              : <Link href={`/projects/add?path=${encodeURIComponent(l.path)}`} className="button">Use this folder</Link>}
          </p>
        )}
        {l.folders.length ? (
          <ul className="related-rows">
            {l.folders.map((f) => (
              <li key={f.path}>
                <Link href={`/projects/add?browse=${encodeURIComponent(f.path)}`} className="related-row">
                  <I icon={Folder} size={18} className="muted" />
                  <span className="body">
                    <span className="name"><strong>{f.name}</strong>
                      {f.registeredAs ? <span className="badge">In the library as {f.registeredAs}</span> : f.looksLikeProject && <span className="badge accent">Looks like a project</span>}
                    </span>
                  </span>
                  <I icon={ChevronRight} className="muted" />
                </Link>
              </li>
            ))}
          </ul>
        ) : <Empty title="No folders here." />}
        <p className="hint">Only folders inside your allowed folders are shown (Settings → Allowed Folders), and only their names. Hidden folders are left out.</p>
      </section>

      <section className="card" style={{ marginTop: 24 }} aria-labelledby="path-title">
        <h2 id="path-title" className="panel-title">Or type the folder's path</h2>
        <form action="/projects/add" method="get" className="inline">
          <label className="sr-only" htmlFor="path">Folder path</label>
          <input id="path" name="path" required placeholder="~/my-app" style={{ flex: 1, minWidth: 240 }} />
          <button type="submit">Use this path</button>
        </form>
      </section>
    </>
  );
}

function Review({ s }: { s: FolderSuggestion }) {
  if (s.duplicate)
    return (
      <section className="card existing found" aria-label="Already in the library">
        <p className="existing-result"><I icon={CircleAlert} size={20} className="warn-icon" /> Already in the library</p>
        <p className="hint" style={{ margin: "4px 0 12px 32px" }}><code>{s.path}</code> is already added as “{s.duplicate.name}”.</p>
        <p style={{ marginLeft: 32 }}><Link href={`/projects/${s.duplicate.id}`} className="button">Open {s.duplicate.name}</Link> <Link href="/projects/add" style={{ marginLeft: 12 }}>Choose a different folder</Link></p>
      </section>
    );
  return (
    <section className="card" aria-labelledby="review-title">
      <h2 id="review-title" className="panel-title">Review</h2>
      <div className="path-bar"><I icon={FolderOpen} size={16} /> <code>{s.path}</code> <Link href={`/projects/add?browse=${encodeURIComponent(s.path)}`}>Choose a different folder</Link></div>
      {s.overlaps.map((o) => (
        <p key={o.project.id} className="hint">
          Note: {o.relation === "inside" ? <>this folder contains “{o.project.name}”, which is already in the library.</> : <>this folder is inside “{o.project.name}”, which is already in the library.</>}
        </p>
      ))}
      <ActionForm op="project.register" submit="Add project" pendingLabel="Adding the project…" returnTo={`/projects/add?path=${encodeURIComponent(s.path)}`}>
        <input type="hidden" name="path" value={s.path} />
        <label>Name<input name="name" defaultValue={s.name} required maxLength={120} /></label>
        <label>Description<textarea name="description" className="plain" rows={3} defaultValue={s.description} placeholder="What the project is for" /></label>
        <p className="hint" style={{ margin: 0 }}>
          Suggested from {s.sources.length > 1 ? `${s.sources.slice(0, -1).join(", ")} and ${s.sources.at(-1)}` : s.sources[0]}.
          {(s.technology.length > 0 || s.git) && <> Looks like: {[...s.technology, ...(s.git ? ["a git repository"] : [])].join(", ")}.</>}
        </p>
      </ActionForm>
      <p className="hint">Adding records the project in the library only. Nothing in its folder is created, changed or deleted.</p>
    </section>
  );
}
