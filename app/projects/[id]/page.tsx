import Link from "next/link";
import { getLib } from "@/src/web/lib";
import { ActionForm, CopyButton } from "@/src/ui/client";
import { ConfirmAction } from "@/src/ui/confirm";
import { RemoveFromProject } from "@/src/ui/remove-from-project";
import { OpenInClaudeCode } from "@/src/ui/open-in-claude";
import { Ago, Empty, Flash, TestBadge, day, orNotFound, plural, when, type SP } from "@/src/ui/server";
import { ArrowLeft, ChevronRight, Folder, I, Package, categoryIcon } from "@/src/ui/icons";
import type { ProjectDetail } from "@/src/core";

export const dynamic = "force-dynamic";

const TABS = ["overview", "components", "runs", "settings"] as const;
type Tab = (typeof TABS)[number];

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const lib = getLib();
  const p = orNotFound(() => lib.projects.get(id));
  const tab: Tab = (TABS as readonly string[]).includes(sp.tab ?? "") ? (sp.tab as Tab) : "overview";
  const runs = p.components
    .flatMap((c) => lib.tests.list(c.componentId, 20).map((r) => ({ ...r, componentName: c.name, slug: c.slug })))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  return (
    <>
      <Link href="/projects" className="crumb"><I icon={ArrowLeft} size={16} /> My Projects</Link>
      <header className="page-head" style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", gap: 16, alignItems: "center", minWidth: 0 }}>
          <span className="tile"><I icon={Folder} size={26} /></span>
          <div style={{ minWidth: 0 }}>
            <h1>{p.name}</h1>
            {p.description && <p className="subtitle" style={{ fontSize: 14, marginTop: 4 }}>{p.description}</p>}
          </div>
        </div>
        <div className="actions"><OpenInClaudeCode projectId={p.id} /><CopyButton text={p.path} label="Copy folder path" /></div>
      </header>
      <Flash sp={sp} />
      <nav className="tabs" aria-label="Project sections">
        {TABS.map((t) => (
          <Link key={t} href={`/projects/${p.id}?tab=${t}`} className={t === tab ? "active" : undefined} aria-current={t === tab ? "page" : undefined}>
            {t[0].toUpperCase() + t.slice(1)}
          </Link>
        ))}
      </nav>
      {tab === "overview" && <Overview p={p} runCount={runs.length} />}
      {tab === "components" && <Components p={p} add={sp.add} />}
      {tab === "runs" && <Runs p={p} runs={runs} />}
      {tab === "settings" && <SettingsTab p={p} />}
    </>
  );
}

function Overview({ p, runCount }: { p: ProjectDetail; runCount: number }) {
  return (
    <div className="panels">
      <section className="card" aria-labelledby="details-title">
        <h2 id="details-title" className="panel-title">Project Details</h2>
        <dl className="facts">
          <dt>Name</dt><dd>{p.name}</dd>
          <dt>Description</dt><dd>{p.description || <span className="muted">None</span>}</dd>
          <dt>Folder</dt>
          <dd><code>{p.path}</code><div><span className={`badge ${p.pathStatus}`}>{p.pathStatus === "present" ? "folder found" : "folder not found now"}</span></div></dd>
          <dt>Added</dt><dd>{day(p.createdAt)}</dd>
          <dt>Last updated</dt><dd><Ago iso={p.lastChangedAt} /></dd>
          <dt>Components used</dt><dd>{p.components.length}</dd>
          {p.originOf.length > 0 && <><dt>Captured from here</dt><dd>{p.originOf.length}</dd></>}
          <dt>Test runs</dt><dd>{runCount}</dd>
        </dl>
        <Link href={`/projects/${p.id}?tab=settings`} className="button secondary" style={{ marginTop: 24, width: "100%", justifyContent: "center" }}>Edit Details</Link>
      </section>
      <section className="card" aria-labelledby="used-title">
        <h2 id="used-title" className="panel-title">
          Components
          {p.components.length > 0 && <Link href={`/projects/${p.id}?tab=components`} className="small">View all</Link>}
        </h2>
        {p.components.length ? (
          <ul className="rows">
            {p.components.slice(0, 5).map((c) => (
              <li key={c.componentId}>
                <Link href={`/components/${c.slug}`} className="row-link" style={{ padding: 12 }}>
                  <span className="tile sm"><I icon={categoryIcon(c.categoryName)} size={18} /></span>
                  <span className="body"><strong>{c.name}</strong><div className="desc">{c.categoryName}</div></span>
                  <span className="meta">
                    {c.version ? `v${c.version}` : "version not recorded"}
                    {c.upgradeAvailable && <> · <span className="badge timeout">{c.latestVersion} available</span></>}
                    <div className="small faint">added <Ago iso={c.linkedAt} /></div>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : <Empty title="No components recorded."><p><Link href={`/projects/${p.id}?tab=components`}>Add one</Link> it uses.</p></Empty>}
      </section>
    </div>
  );
}

const INTEGRATION = {
  connected: ["connected", "Connected"],
  added: ["added", "Added"],
  "": ["", "Recorded"],
} as const;

function Components({ p, add }: { p: ProjectDetail; add?: string }) {
  const lib = getLib();
  const available = lib.components.search("", { limit: 1000 }).filter((c) => !p.components.some((u) => u.componentId === c.id));
  const here = `/projects/${p.id}?tab=components`;
  return (
    <>
      <h2 style={{ marginTop: 0 }}>Shared components used</h2>
      {p.components.length ? (
        <div className="table-card">
          <table>
            <thead><tr><th>Component</th><th>Version</th><th>In the project</th><th>Note</th><th></th></tr></thead>
            <tbody>
              {p.components.map((c) => (
                <tr key={c.componentId}>
                  <td><Link href={`/components/${c.slug}`}>{c.name}</Link><div className="muted small">{c.categoryName}</div></td>
                  <td>
                    {c.version ? <code>{c.version}</code> : <span className="muted">version not recorded</span>}
                    {c.upgradeAvailable && <> <span className="badge timeout">{c.latestVersion} available</span></>}
                    {c.latestVersion && !c.integration && (
                      <ActionForm op="project.setVersion" submit="Set version" className="inline" returnTo={here}>
                        <input type="hidden" name="project" value={p.id} />
                        <input type="hidden" name="component" value={c.componentId} />
                        <label className="sr-only" htmlFor={`v-${c.componentId}`}>Version of {c.name}</label>
                        <select id={`v-${c.componentId}`} name="version" defaultValue={c.version || c.latestVersion}>
                          {lib.components.get(c.componentId).releasedVersions.map((v) => <option key={v} value={v}>{v}</option>)}
                        </select>
                      </ActionForm>
                    )}
                  </td>
                  <td style={{ maxWidth: 320 }}>
                    <span className={`badge ${INTEGRATION[c.integration][0]}`}>{INTEGRATION[c.integration][1]}</span>
                    <div className="hint" style={{ marginTop: 4 }}>
                      {c.integration ? c.integrationDetail : "Only recorded here. The library didn't copy any files, so it can't say whether the project uses it."}
                      {c.integrationCheckedAt && <> (<Ago iso={c.integrationCheckedAt} />)</>}
                    </div>
                    {c.integration && (
                      <ActionForm op="project.checkConnection" submit="Check connection" pendingLabel="Running the project's tests in the sandbox…" className="inline" returnTo={here} lock="project-check">
                        <input type="hidden" name="project" value={p.id} />
                        <input type="hidden" name="component" value={c.componentId} />
                      </ActionForm>
                    )}
                  </td>
                  <td className="muted">{c.note}<div className="small">added {when(c.linkedAt)}</div></td>
                  <td>
                    <RemoveFromProject project={{ id: p.id, name: p.name }} component={{ id: c.componentId, name: c.name }} returnTo={here} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty title="No components recorded for this project." />}

      <h2>Add a component from your library</h2>
      <AddFromLibrary p={p} add={add} />

      <details className="reveal" style={{ marginTop: 16 }}>
        <summary className="hint" style={{ cursor: "pointer" }}>Or only record that it uses a component (no files copied)</summary>
        {available.length ? (
          <ActionForm op="project.link" submit="Record it" className="inline" returnTo={here}>
            <input type="hidden" name="project" value={p.id} />
            <label className="sr-only" htmlFor="add-component">Component</label>
            <select id="add-component" name="component" required defaultValue="">
              <option value="" disabled>Choose a component</option>
              {available.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.categoryName})</option>)}
            </select>
            <input name="version" placeholder="Version (blank = newest release)" aria-label="Version" />
            <input name="note" placeholder="How it's used (optional)" aria-label="Note" />
          </ActionForm>
        ) : <p className="muted">Every component is already recorded, or the library is empty.</p>}
        <p className="hint">This records the relationship in the library only, shown as Recorded. Nothing in the project folder is changed.</p>
      </details>

      {p.originOf.length > 0 && (
        <>
          <h2>Captured from this project</h2>
          <p className="hint">These components' code was copied out of this project into the library. That is where they came from, not a record that this project uses the released copy.</p>
          <ul className="rows">
            {p.originOf.map((c) => (
              <li key={c.componentId}>
                <Link href={`/components/${c.slug}`} className="row-link">
                  <span className="tile sm"><I icon={Package} size={18} /></span>
                  <span className="body"><strong>{c.name}</strong></span>
                  <I icon={ChevronRight} className="muted" />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function Runs({ p, runs }: { p: ProjectDetail; runs: (ReturnType<ReturnType<typeof getLib>["tests"]["list"]>[number] & { componentName: string; slug: string })[] }) {
  return (
    <>
      <p className="hint" style={{ marginTop: 0 }}>
        Tests belong to components, not projects. These are the real test runs of the {plural(p.components.length, "component")} this project uses, newest first.
      </p>
      {runs.length ? (
        <ul className="rows">
          {runs.map((r) => (
            <li key={r.id}>
              <Link href={`/components/${r.slug}?tab=tests`} className="row-link">
                <TestBadge status={r.status} />
                <span className="body">
                  <strong>{r.componentName}</strong>
                  <div className="desc"><code>{r.command}</code> · exit {r.exitCode ?? "none"} · {(r.durationMs / 1000).toFixed(1)}s</div>
                </span>
                <span className="meta"><Ago iso={r.startedAt} /></span>
                <I icon={ChevronRight} className="muted" />
              </Link>
            </li>
          ))}
        </ul>
      ) : <Empty title="No test runs yet.">{p.components.length ? <p>Run tests from a component's Tests tab.</p> : <p>This project uses no components yet.</p>}</Empty>}
    </>
  );
}

function SettingsTab({ p }: { p: ProjectDetail }) {
  return (
    <>
      <section className="card" style={{ maxWidth: 760 }} aria-labelledby="edit-title">
        <h2 id="edit-title" className="panel-title">Edit project</h2>
        <ActionForm op="project.update" submit="Save project" returnTo={`/projects/${p.id}?tab=settings`}>
          <input type="hidden" name="ref" value={p.id} />
          <label>Name<input name="name" defaultValue={p.name} required /></label>
          <label>Folder path<input name="path" defaultValue={p.path} required /></label>
          <label>Description<input name="description" defaultValue={p.description} /></label>
        </ActionForm>
      </section>
      <section className="card" style={{ maxWidth: 760, marginTop: 24 }} aria-labelledby="remove-title">
        <h2 id="remove-title" className="panel-title">Remove from library</h2>
        <p className="hint">Forgets this project and its component links. You choose whether its folder stays on your Mac.</p>
        <RemoveProject p={p} />
      </section>
    </>
  );
}

function RemoveProject({ p }: { p: ProjectDetail }) {
  const folder = getLib().removal.projectFolder(p.id);
  return (
    <ConfirmAction op="project.unregister" fields={{ ref: p.id }} trigger="Remove project" title={`Remove “${p.name}”?`} confirmLabel="Remove" typeToConfirm
      choiceName="folder" pendingLabel="Removing…"
      choices={[
        { value: "keep", label: "Remove from the library only", detail: <>The folder stays on your Mac: <code>{p.path}</code></> },
        { value: "trash", label: "Move folder to the Trash", detail: <>You can get it back from the Trash. <code>{p.path}</code></>, disabledWhy: folder.canTrash ? undefined : `Not available: ${folder.why}` },
      ]}>
      <p>It's taken out of your library, with its list of components.</p>
    </ConfirmAction>
  );
}

/** Add (copy) a component's release into the project. Shows exactly what will happen first; changes nothing until approved. */
function AddFromLibrary({ p, add }: { p: ProjectDetail; add?: string }) {
  const lib = getLib();
  const here = `/projects/${p.id}?tab=components`;
  const choices = lib.components.search("", { limit: 1000 }).filter((c) => c.version && lib.components.get(c.id).releasedVersions.length);
  let preview: ReturnType<typeof lib.integration.preview> | null = null;
  let problem = "";
  if (add) { try { preview = lib.integration.preview(p.id, add); } catch (err) { problem = (err as Error).message; } }
  return (
    <section className="card">
      <form action={`/projects/${p.id}`} method="get" className="inline">
        <input type="hidden" name="tab" value="components" />
        <label className="sr-only" htmlFor="add-from-library">Component</label>
        <select id="add-from-library" name="add" required defaultValue={add ?? ""}>
          <option value="" disabled>Choose a component</option>
          {choices.map((c) => <option key={c.id} value={c.slug}>{c.name} {c.version}</option>)}
        </select>
        <button type="submit" className="secondary">Show what it will add</button>
      </form>
      {problem && <p className="flash error" role="alert" style={{ marginTop: 16 }}>{problem}</p>}
      {preview && (
        <div style={{ marginTop: 16 }}>
          <p style={{ marginTop: 0 }}>Copies <strong>{preview.component.name} {preview.version}</strong> unchanged into <code>{preview.dest}</code> ({preview.files.length} files). Nothing else in the project is created or changed.</p>
          <p className="hint">Read from its code: {preview.inspection.usesNetwork ? "uses the network" : "no network"}, {preview.inspection.readsFiles ? "reads files" : "doesn't read files"}. Public functions: {preview.inspection.api.slice(0, 8).map((f) => f.name).join(", ") || "none found"}.</p>
          {preview.problems.length ? <ul className="problems">{preview.problems.map((x) => <li key={x}>{x}</li>)}</ul> : (
            <>
              <p className="hint">After adding, it shows as <strong>Added</strong>. To use it, paste this where your code needs it, then use <em>Check connection</em>: it becomes <strong>Connected</strong> once the project's own tests call it.</p>
              <pre>{preview.snippet}</pre>
              <ActionForm op="project.addComponent" submit={`Approve: add ${preview.component.name} ${preview.version}`} pendingLabel="Copying the component…" returnTo={`${here}&add=${preview.component.slug}`}>
                <input type="hidden" name="project" value={p.id} />
                <input type="hidden" name="component" value={preview.component.id} />
                <input type="hidden" name="version" value={preview.version} />
              </ActionForm>
            </>
          )}
        </div>
      )}
    </section>
  );
}
