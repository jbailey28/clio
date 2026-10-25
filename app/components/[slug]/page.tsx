import Link from "next/link";
import { getLib } from "@/src/web/lib";
import { ActionForm } from "@/src/ui/client";
import { ConfirmAction } from "@/src/ui/confirm";
import { ComponentFields } from "@/src/ui/component-fields";
import { Empty, Flash, TestBadge, orNotFound, when, type SP } from "@/src/ui/server";
import { ArrowLeft, I, categoryIcon } from "@/src/ui/icons";
import { RemoveFromProject } from "@/src/ui/remove-from-project";
import type { ComponentDetail, IOItem } from "@/src/core";

export const dynamic = "force-dynamic";

const TABS = ["overview", "configuration", "tests", "usage"] as const;

export default async function ComponentPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: SP }) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const lib = getLib();
  const c = orNotFound(() => lib.components.get(slug));
  const tab = (TABS as readonly string[]).includes(sp.tab ?? "") ? sp.tab! : "overview";
  if (tab === "overview") lib.components.markViewed(c.id);

  return (
    <>
      <Link href={`/categories/${c.categorySlug}`} className="crumb"><I icon={ArrowLeft} size={16} /> {c.categoryName}</Link>
      <header className="page-head" style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", gap: 16, alignItems: "center", minWidth: 0 }}>
          <span className="tile"><I icon={categoryIcon(c.categoryName)} size={26} /></span>
          <div style={{ minWidth: 0 }}>
            <h1>{c.name}</h1>
            <p className="subtitle" style={{ fontSize: 14, marginTop: 4 }}>
              {c.version && <span className="badge accent">v{c.version}</span>} <TestBadge status={c.lastTestStatus} />
            </p>
          </div>
        </div>
      </header>
      <Flash sp={sp} />
      <nav className="tabs" aria-label="Component sections">
        {TABS.map((t) => (
          <Link key={t} href={`/components/${c.slug}?tab=${t}`} className={t === tab ? "active" : undefined} aria-current={t === tab ? "page" : undefined}>
            {t[0].toUpperCase() + t.slice(1)}
          </Link>
        ))}
      </nav>
      {tab === "overview" && <Overview c={c} />}
      {tab === "configuration" && <Configuration c={c} />}
      {tab === "tests" && <Tests c={c} />}
      {tab === "usage" && <Usage c={c} />}
    </>
  );
}

function IOTable({ items, empty }: { items: IOItem[]; empty: string }) {
  if (!items.length) return <p className="muted">{empty}</p>;
  return (
    <div className="table-card"><table>
      <tbody>
        {items.map((i) => (
          <tr key={i.id}><td><code>{i.name}</code></td><td className="muted"><code>{i.type}</code></td><td>{i.description}</td></tr>
        ))}
      </tbody>
    </table></div>
  );
}

function Overview({ c }: { c: ComponentDetail }) {
  const caps = c.capabilities.filter((x) => x.kind === "capability");
  const checks = c.capabilities.filter((x) => x.kind === "check");
  return (
    <>
      {c.summary && <p style={{ fontSize: 15, marginTop: 0 }}>{c.summary}</p>}
      <p className="muted small">
        Slug <code>{c.slug}</code> · ID <code>{c.id}</code>
        {c.language && <> · {c.language}</>}{c.version && <> · v{c.version}</>} · updated {when(c.updatedAt)}
      </p>

      <h2>Source</h2>
      <div className="table-card"><table>
        <tbody>
          {c.sources.map((s) => (
            <tr key={s.id}>
              <td><code>{s.path}</code></td>
              <td className="muted">{s.kind}{s.isPrimary ? " · primary" : ""}</td>
              <td><span className={`badge ${s.status}`}>{s.status === "present" ? "found on disk" : "not found on disk now"}</span></td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {c.origin && (
        <p className="hint">
          Captured from {c.origin.project ? <Link href={`/projects/${c.origin.project.id}`}>{c.origin.project.name}</Link> : "a folder that isn't a project in the library"}
          {c.origin.paths.length > 0 && <> (<code>{c.origin.paths.join(", ")}</code>)</>}. That is where the code came from, not a project that uses it.
        </p>
      )}

      <h2>Capabilities</h2>
      {caps.length ? <ul>{caps.map((x) => <li key={x.id}><strong>{x.name}</strong>{x.description && <> — {x.description}</>}</li>)}</ul>
        : <p className="muted">None listed.</p>}
      <h2>Checks</h2>
      {checks.length ? <ul>{checks.map((x) => <li key={x.id}><strong>{x.name}</strong>{x.description && <> — {x.description}</>}</li>)}</ul>
        : <p className="muted">None listed.</p>}

      <div className="row">
        <div><h2>Inputs</h2><IOTable items={c.inputs} empty="None listed." /></div>
        <div><h2>Outputs</h2><IOTable items={c.outputs} empty="None listed." /></div>
      </div>

      <h2>Dependencies</h2>
      {c.dependencies.length ? (
        <ul>
          {c.dependencies.map((d) => (
            <li key={d.id}>
              <span className="muted">{d.type}:</span>{" "}
              {d.type === "component" && d.dependsOnComponentId ? <Link href={`/components/${d.name}`}>{d.name}</Link> : <code>{d.name}</code>}
              {d.version && <span className="muted"> @ {d.version}</span>}
            </li>
          ))}
        </ul>
      ) : <p className="muted">None listed.</p>}

      <h2>Tests</h2>
      <p>
        {c.lastTestStatus ? <>Last run {when(c.lastTestAt)}: <TestBadge status={c.lastTestStatus} /></> : <span className="muted">No test has been run, so there is no result yet.</span>}{" "}
        <Link href={`/components/${c.slug}?tab=tests`}>Open Tests</Link>
      </p>

      <Releases c={c} />

      <h2>Documentation</h2>
      {c.documentation ? <pre>{c.documentation}</pre> : <p className="muted">No documentation yet.</p>}
    </>
  );
}

function Releases({ c }: { c: ComponentDetail }) {
  const lib = getLib();
  const releases = lib.releases.list(c.id);
  return (
    <>
      <h2>Releases</h2>
      {releases.length === 0 ? (
        <p className="muted">No release recorded. The version number above is not tied to a frozen copy yet.</p>
      ) : (
        <div className="table-card"><table>
          <thead><tr><th>Version</th><th>Released</th><th>Files</th><th>What changed</th></tr></thead>
          <tbody>
            {releases.map((r) => {
              const check = lib.releases.verify(c.id, r.version);
              return (
                <tr key={r.id}>
                  <td><strong>{r.version}</strong>{r === releases[0] && <span className="badge"> latest</span>}</td>
                  <td className="muted small">{when(r.releasedAt)}{r.gitTag && <div><code>{r.gitTag}</code></div>}</td>
                  <td>
                    <span className={`badge ${check.state === "intact" ? "present" : "missing"}`}>{check.state}</span>
                    <div className="small"><code>{r.sourcePath}</code></div>
                    <div className="muted small">sha256 {r.checksum.slice(0, 12)}… · {r.fileCount} files</div>
                  </td>
                  <td><pre style={{ maxHeight: 160, margin: 0 }}>{r.changes}</pre></td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
    </>
  );
}

function VersionCell({ version, latest, upgrade }: { version: string; latest: string; upgrade: boolean }) {
  return (
    <>
      {version ? <code>{version}</code> : <span className="muted">not recorded</span>}
      {upgrade && <> <span className="badge timeout">{latest} available</span></>}
    </>
  );
}

function Configuration({ c }: { c: ComponentDetail }) {
  const categories = getLib().categories.list();
  return (
    <>
      <div className="card">
        <ActionForm op="component.update" submit="Save changes">
          <input type="hidden" name="ref" value={c.id} />
          <ComponentFields categories={categories} c={c} />
        </ActionForm>
      </div>
      <h2>Delete component</h2>
      <DeleteComponent c={c} />
    </>
  );
}

function DeleteComponent({ c }: { c: ComponentDetail }) {
  const files = getLib().removal.componentFiles(c.id);
  const elsewhere = files.elsewhere.length ? <span className="choice-detail">Not touched either way: {files.elsewhere.map((f) => <code key={f}>{f}</code>)}</span> : null;
  return (
    <ConfirmAction op="component.delete" fields={{ ref: c.id }} trigger="Delete component" title={`Delete “${c.name}”?`} confirmLabel="Delete" typeToConfirm
      blockedWhy={c.projects.length ? `It's used by ${c.projects.map((p) => p.projectName).join(", ")}. Remove it from ${c.projects.length === 1 ? "that project" : "those projects"} first.` : undefined}
      choiceName="files" pendingLabel="Deleting…"
      choices={files.library.length ? [
        { value: "keep", label: "Delete from the library only", detail: <>Its files stay on your Mac.{elsewhere}</> },
        { value: "trash", label: "Move files to the Trash", detail: <>{files.library.map((f) => <code key={f}>{f}</code>)}{elsewhere}</> },
      ] : undefined}>
      {!files.library.length && <p>It's removed from your library. {files.elsewhere.length ? "Its files are in another folder and stay where they are." : "It has no files on your Mac."}</p>}
      {files.library.length > 0 && <p>It's removed from your library, with its saved versions and test history.</p>}
    </ConfirmAction>
  );
}

function Tests({ c }: { c: ComponentDetail }) {
  const runs = getLib().tests.list(c.id, 20);
  return (
    <>
      {c.testCommand ? (
        <>
          <p>Command: <code>{c.testCommand}</code></p>
          <p className="muted small">Runs in {c.testCwd ? <code>{c.testCwd}</code> : "the primary source folder"}. Results below are what the command actually printed.</p>
          <ActionForm op="component.test" submit="Run tests now" pendingLabel="Running tests…">
            <input type="hidden" name="ref" value={c.id} />
          </ActionForm>
        </>
      ) : (
        <p className="muted">No test command set. Add one under <Link href={`/components/${c.slug}?tab=configuration`}>Configuration</Link>. Until a test runs, there is no result.</p>
      )}
      <h2>Runs</h2>
      {runs.length === 0 ? <Empty title="No runs yet." /> : runs.map((r) => (
        <details key={r.id} open={r === runs[0]} className="card" style={{ marginBottom: 8 }}>
          <summary>
            <TestBadge status={r.status} /> {when(r.startedAt)} · exit {r.exitCode ?? "none"} · {(r.durationMs / 1000).toFixed(1)}s
          </summary>
          <p className="small muted"><code>{r.command}</code> in <code>{r.cwd}</code></p>
          <h3>stdout</h3><pre>{r.stdout || "(empty)"}</pre>
          <h3>stderr</h3><pre>{r.stderr || "(empty)"}</pre>
        </details>
      ))}
    </>
  );
}

function Usage({ c }: { c: ComponentDetail }) {
  const projects = getLib().projects.list().filter((p) => !c.projects.some((u) => u.projectId === p.id));
  return (
    <>
      <h2>Used by</h2>
      {c.projects.length ? (
        <div className="table-card"><table>
          <tbody>
            {c.projects.map((p) => (
              <tr key={p.projectId}>
                <td><Link href={`/projects/${p.projectId}`}>{p.projectName}</Link><div className="muted small"><code>{p.projectPath}</code></div></td>
                <td><VersionCell version={p.version} latest={p.latestVersion} upgrade={p.upgradeAvailable} /></td>
                <td className="muted">{p.note}</td>
                <td>
                  <RemoveFromProject project={{ id: p.projectId, name: p.projectName }} component={{ id: c.id, name: c.name }} returnTo={`/components/${c.slug}?tab=usage`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ) : <Empty title="No project in the library is recorded as using this component." />}
      <h2>Add to a project</h2>
      {projects.length ? (
        <ActionForm op="project.link" submit="Add to project" className="inline" returnTo={`/components/${c.slug}?tab=usage`}>
          <input type="hidden" name="component" value={c.id} />
          <select name="project" required defaultValue="" aria-label="Project">
            <option value="" disabled>Choose a project</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {c.releasedVersions.length > 0 && (
            <select name="version" defaultValue={c.releasedVersions[0]} aria-label="Version">
              {c.releasedVersions.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          )}
          <input name="note" placeholder="How it's used (optional)" aria-label="Note" />
        </ActionForm>
      ) : <p className="muted">No other projects in the library. <Link href="/projects/new">Add a project</Link>.</p>}
      <p className="hint">This records the relationship in the library only. Nothing in the project folder is changed.</p>
    </>
  );
}
