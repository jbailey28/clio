import Link from "next/link";
import type { ReactNode } from "react";
import { getLib } from "@/src/web/lib";
import { ActionForm, LiveActivity } from "@/src/ui/client";
import { ConfirmAction } from "@/src/ui/confirm";
import { OpenInClaudeCode } from "@/src/ui/open-in-claude";
import { Dictation } from "@/src/ui/dictation";
import { ComponentsEditor, PlanEditor } from "@/src/ui/project-steps";
import { Flash, PageHead, StepBar, orNotFound, type SP } from "@/src/ui/server";
import { ArrowLeft, CircleAlert, CircleCheck, FileText, I, Sparkles, TriangleAlert } from "@/src/ui/icons";
import type { ProjectDraft } from "@/src/core";

export const dynamic = "force-dynamic";

const STEP_KEYS = ["describe", "plan", "components", "build", "test"] as const;

export default async function CreateProjectSteps({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const lib = getLib();
  const d = orNotFound(() => lib.projectCreation.get(id));
  const back = <Link href="/projects/create" className="crumb"><I icon={ArrowLeft} size={16} /> Create project</Link>;

  if (d.legacy) {
    return (
      <>
        {back}
        <PageHead title="Create project" />
        <p className="flash error" role="alert">This plan was made with an earlier version of Create project, so it can't be continued. <Link href="/projects/create">Start a new plan</Link>.</p>
        <Discard d={d} />
      </>
    );
  }

  const f = lib.projectCreation.freshness(d);
  const reachable = [true, !!d.plan, !!d.analysis, f.components === "current", f.build === "current" && !d.build!.problems.length];
  const furthest = d.project || d.tests ? 4 : f.build === "current" ? 3 : d.analysis ? 2 : d.plan ? 1 : 0;
  const asked = STEP_KEYS.indexOf((sp.step ?? "") as (typeof STEP_KEYS)[number]);
  const step = asked >= 0 && reachable[asked] ? asked : Math.min(furthest, reachable.lastIndexOf(true));
  const hrefs = STEP_KEYS.map((k, i) => (reachable[i] ? `/projects/create/${d.id}?step=${k}` : null));
  const active = lib.creation.active(d);
  const status = `/api/create/status?draft=${d.id}`;

  return (
    <>
      {back}
      <PageHead title="Create project" />
      <StepBar current={step} hrefs={hrefs} />
      <Flash sp={sp} />
      {active && <LiveActivity statusUrl={status} step={active.step} detail={active.detail} lock="project" />}
      {d.lastError && !sp.error && !active && <p className="flash error" role="alert"><strong>That didn't work.</strong> {d.lastError.message}</p>}

      {step === 0 && <Describe d={d} status={status} />}
      {step === 1 && <Plan d={d} status={status} />}
      {step === 2 && <Components d={d} status={status} />}
      {step === 3 && <Build d={d} status={status} />}
      {step === 4 && <Test d={d} status={status} />}

      {!d.project && <Discard d={d} />}
    </>
  );
}

function Card({ title, children, intro }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section className="card step-card" aria-label={title}>
      <h2 className="step-title">{title}</h2>
      {intro && <p className="step-intro">{intro}</p>}
      {children}
    </section>
  );
}

function Discard({ d }: { d: ProjectDraft }) {
  return (
    <section className="discard" aria-label="Discard">
      <ConfirmAction op="projectDraft.discard" fields={{ draft: d.id }} trigger="Discard this plan" title="Discard this plan?" confirmLabel="Discard" pendingLabel="Discarding…" lock="project" returnTo={`/projects/create/${d.id}`}>
        <p>The plan and anything built for it so far are deleted. No project folder is created or changed.</p>
      </ConfirmAction>
    </section>
  );
}

// ---------- 1. describe ----------

function Describe({ d, status }: { d: ProjectDraft; status: string }) {
  return (
    <Card title="Describe the project" intro={d.plan ? "Change the description only if you want a new plan. Continuing without a change keeps your plan as it is." : undefined}>
      <ActionForm op="projectDraft.replan" submit="Continue" pendingLabel="Writing the plan…" statusUrl={status} lock="project">
        <input type="hidden" name="draft" value={d.id} />
        <textarea id="prompt" name="prompt" required minLength={10} maxLength={4000} rows={5} className="prompt" defaultValue={d.prompt} aria-label="Describe the project" disabled={!!d.project} />
        {!d.project && <Dictation target="prompt" />}
      </ActionForm>
    </Card>
  );
}

// ---------- 2. plan ----------

function Plan({ d, status }: { d: ProjectDraft; status: string }) {
  const lib = getLib();
  if (!d.plan) {
    return (
      <Card title="Plan" intro="There's no plan yet.">
        <ActionForm op="projectDraft.retry" submit="Try again" pendingLabel="Writing the plan…" statusUrl={status} lock="project">
          <input type="hidden" name="draft" value={d.id} />
        </ActionForm>
      </Card>
    );
  }
  const p = d.plan;
  return (
    <Card title={p.openEnded ? "Here's a small project you could build from that idea" : "Review the plan"} intro={p.summary}>
      <PlanEditor key={d.planRevision ?? 0} draftId={d.id} plan={p} statusUrl={status} readOnly={!!d.project}
        undo={d.undo.at(-1)?.instruction ?? null} refined={d.refined}
        componentsCurrent={lib.projectCreation.freshness(d).components === "current"} />
    </Card>
  );
}

// ---------- 3. components ----------

function Components({ d, status }: { d: ProjectDraft; status: string }) {
  const lib = getLib();
  const a = d.analysis!;
  if (lib.projectCreation.freshness(d).components !== "current") {
    return (
      <Card title="Components">
        <p className="notes"><I icon={TriangleAlert} size={14} /> The plan changed since components were matched to it, so this list is out of date.</p>
        <ActionForm op="projectDraft.analyze" submit="Update components" pendingLabel="Matching your plan to your components…" statusUrl={status} lock="project">
          <input type="hidden" name="draft" value={d.id} />
        </ActionForm>
      </Card>
    );
  }
  const toBuild = a.needs.filter((n) => n.status === "build");
  return (
    <Card title="Components"
      intro={a.components.length ? "What the project needs, and where each part comes from. Turn off a component to have that part built in the project instead." : undefined}>
      {!a.components.length && (
        <div className="none-found">
          <p><strong>No existing components found.</strong></p>
          {toBuild.length > 0 && <p className="muted">Will be built in the project: {toBuild.map((n) => n.need).join(", ")}.</p>}
        </div>
      )}
      <ComponentsEditor key={a.key} draftId={d.id} needs={a.needs} components={a.components}
        useComponent={d.choice.useComponent} includeNeed={d.choice.includeNeed} readOnly={!!d.project} />
    </Card>
  );
}

// ---------- 4. build ----------

const list = (xs: string[], none: string) => (xs.length ? xs.join(", ") : none);

function Build({ d, status }: { d: ProjectDraft; status: string }) {
  const lib = getLib();
  const a = d.analysis!;
  const p = d.plan!;
  const dec = lib.projectCreation.decisions(d);
  const f = lib.projectCreation.freshness(d);
  const root = lib.projectCreation.root();
  const blockers = lib.projectCreation.readyToBuild(d);
  const kept = dec.needs.filter((n) => n.included);
  const built = kept.filter((n) => !n.using && n.status !== "setup").map((n) => n.need);
  const setup = kept.filter((n) => n.status === "setup");
  const b = d.build;
  const current = f.build === "current" && b;

  return (
    <Card title="Build">
      <dl className="summary">
        <dt>What will be built</dt><dd>{p.description}{built.length ? <span className="muted"> Written in the project: {built.join(", ")}.</span> : null}</dd>
        <dt>Components reused</dt><dd>{list(dec.components.map((c) => `${c.name} ${c.version}`), "None")}</dd>
        <dt>How it connects</dt><dd>{a.connections.length ? a.connections.join(" → ") : "It runs on its own."}</dd>
        <dt>Setup needed</dt><dd>{list(setup.map((n) => n.need), "Nothing")}</dd>
        <dt>Saved to</dt>
        <dd>
          <code>{root.path}/{d.choice.folder || "…"}</code>
          {!d.project && (
            <details className="reveal inline-edit">
              <summary className="link">Change</summary>
              <ActionForm op="projectDraft.folder" submit="Save folder name" pendingLabel="Saving…" lock="project" secondary>
                <input type="hidden" name="draft" value={d.id} />
                <label>Folder name<input name="folder" defaultValue={d.choice.folder} required pattern="[a-z0-9][a-z0-9._\-]{0,63}" /></label>
              </ActionForm>
            </details>
          )}
        </dd>
      </dl>

      {!d.project && blockers.length > 0 && <ul className="problems">{blockers.map((x) => <li key={x}>{x}</li>)}</ul>}

      {!d.project && !blockers.length && !current && (
        <div className="step-actions stacked">
          {b && <p className="notes"><I icon={TriangleAlert} size={14} /> Your plan, choices or folder changed after the last build, so it can't be used. Build again to use them.</p>}
          <ActionForm op="projectDraft.build" submit={b ? "Build again" : "Approve and build"} pendingLabel="Writing the project… this usually takes under 2 minutes" statusUrl={status} lock="project">
            <input type="hidden" name="draft" value={d.id} />
          </ActionForm>
          <p className="hint">It's written in a staging folder and checked. Nothing runs, and nothing goes in your projects folder yet.</p>
        </div>
      )}

      {current && (
        <>
          {b.problems.length ? (
            <div className="result bad"><I icon={CircleAlert} size={18} /><div><strong>The checks found problems, so it won't be run.</strong><ul className="problems">{b.problems.map((x) => <li key={x}>{x}</li>)}</ul></div></div>
          ) : (
            <div className="result ok"><I icon={CircleCheck} size={18} /><div><strong>Built and checked.</strong> <span className="muted">Files stay inside the project, nothing looks like a password or key{dec.components.length ? ", and the project's code calls each component" : ""}.</span></div></div>
          )}
          {!d.project && !b.problems.length && (
            <div className="step-actions"><Link href={`/projects/create/${d.id}?step=test`} className="button">Continue to tests</Link></div>
          )}
          {!d.project && b.problems.length > 0 && <FixWithAI d={d} status={status} next="build" />}
        </>
      )}

      <div className="expanders">
        {current && !d.project && !b.problems.length && <FixWithAI d={d} status={status} next="build" />}
        {current && <ViewFiles d={d} />}
        {a.compatibility.length > 0 && (
          <details className="more"><summary>Compatibility details</summary><div>{a.compatibility.map((x) => <p key={x}>{x}</p>)}</div></details>
        )}
        {setup.length > 0 && (
          <details className="more"><summary>Setup requirements</summary>
            <div>{setup.map((n) => <p key={n.id}><strong>{n.need}.</strong> {n.steps || n.why}</p>)}<p className="hint">None of this is set up for you: nothing is installed and no account is connected.</p></div>
          </details>
        )}
        {dec.components.length > 0 && (
          <details className="more"><summary>Integration details</summary>
            <div>
              {dec.components.map((c) => (
                <p key={c.slug}><strong>{c.name} {c.version}</strong> is copied unchanged into <code>components/{c.slug}/</code>. The project calls {(current && b.usage[c.slug]?.called.length ? b.usage[c.slug].called : c.uses).map((x) => <code key={x}>{x}</code>).reduce((acc: ReactNode[], x, i) => (i ? [...acc, ", ", x] : [x]), [])}.</p>
              ))}
              <p className="hint">The library also writes <code>component_paths.py</code> (so the copies can be imported) and a test that checks the copies still match their releases.</p>
            </div>
          </details>
        )}
      </div>
    </Card>
  );
}

function ViewFiles({ d }: { d: ProjectDraft }) {
  const lib = getLib();
  const b = d.build!;
  const files = lib.projectCreation.files(d);
  const copied = b.files.filter((x) => x.owner === "component").length;
  return (
    <details className="more">
      <summary>View files ({files.length}{copied ? `, plus ${copied} copied component file${copied === 1 ? "" : "s"}` : ""})</summary>
      <ul className="rows">
        {files.map((x) => (
          <li key={x.path}>
            <details className="file">
              <summary><I icon={FileText} size={16} /> <code>{x.path}</code> {b.files.find((y) => y.path === x.path)?.owner === "library" && <span className="badge">written by the library</span>}</summary>
              <pre>{x.content}</pre>
            </details>
          </li>
        ))}
      </ul>
    </details>
  );
}

// ---------- 5. test ----------

function Test({ d, status }: { d: ProjectDraft; status: string }) {
  const lib = getLib();
  const f = lib.projectCreation.freshness(d);
  const dec = lib.projectCreation.decisions(d);
  const t = d.tests;
  const current = f.tests === "current" && t;

  if (d.project) {
    return (
      <Card title="Created">
        <div className="result ok"><I icon={CircleCheck} size={18} /><div><strong>The project was created</strong> in <code>{d.project.path}</code> and added to the library.</div></div>
        <div className="step-actions"><OpenInClaudeCode projectId={d.project.id} className="align-left" /><Link href={`/projects/${d.project.id}`} className="button secondary">Open the project</Link></div>
      </Card>
    );
  }

  if (!current) {
    return (
      <Card title="Test" intro="The project's tests run in a sandbox: no network, and no access to your files. It records which component functions they really call.">
        {t && <p className="notes"><I icon={TriangleAlert} size={14} /> The files changed after the last test run, so those results no longer count.</p>}
        <ActionForm op="projectDraft.test" submit={t ? "Run the tests again" : "Approve and run tests"} pendingLabel="Running the tests…" statusUrl={status} lock="project">
          <input type="hidden" name="draft" value={d.id} />
          <input type="hidden" name="again" value="1" />
        </ActionForm>
      </Card>
    );
  }

  const tests = lib.projectCreation.testList(d);
  const conn = lib.projectCreation.connections(d);
  const ready = lib.projectCreation.ready(d);
  const match = tests.filter((x) => x.copiesMatch);
  const passed = tests.filter((x) => x.passed).length;
  const problems = ready.problems;
  return (
    <Card title="Test">
      <div className={`result ${t.status === "passed" ? "ok" : "bad"}`}>
        <I icon={t.status === "passed" ? CircleCheck : CircleAlert} size={18} />
        <div><strong>{t.status === "passed" ? "All tests passed." : `The tests ${t.status}.`}</strong>{tests.length > 0 && <span className="muted"> {passed} of {tests.length} passed, in {(t.durationMs / 1000).toFixed(1)} seconds.</span>}</div>
      </div>

      {tests.length > 0 && (
        <ul className="test-list" aria-label="Tests">
          {tests.filter((x) => !x.copiesMatch).map((x, i) => (
            <li key={`${x.file}-${x.name}-${i}`}>
              <I icon={x.passed ? CircleCheck : CircleAlert} size={16} className={x.passed ? "ok-icon" : "bad-icon"} />
              <span>{x.name.replace(/^./, (c) => c.toUpperCase())}</span>
              <span className="faint small">{x.passed ? "Passed" : "Failed"}</span>
            </li>
          ))}
        </ul>
      )}

      <dl className="summary">
        {dec.components.length > 0 && (
          <>
            <dt>Components called</dt>
            <dd>{dec.components.map((c) => (
              <span key={c.slug} className="conn"><I icon={conn[c.slug]?.connected ? CircleCheck : CircleAlert} size={14} className={conn[c.slug]?.connected ? "ok-icon" : "warn-icon"} /> {c.name}: {conn[c.slug]?.connected ? `called ${t.calls[c.slug]?.join(", ")}` : conn[c.slug]?.why}</span>
            ))}</dd>
            <dt>Copies match release</dt>
            <dd>{match.length ? (match.every((x) => x.passed) ? "Yes, byte for byte" : "No: a copied component was changed") : "Not checked"}</dd>
          </>
        )}
        <dt>Problems</dt><dd>{problems.length ? <ul className="problems">{problems.map((x) => <li key={x}>{x}</li>)}</ul> : "None"}</dd>
      </dl>

      <details className="more"><summary>Test logs</summary><pre>{(t.stderr + "\n" + t.stdout).replace(/^COMPONENT-CALLS:.*$/m, "").trim() || "(no output)"}</pre></details>

      {problems.length > 0 && <FixWithAI d={d} status={status} next="test" />}
      {problems.length > 0 && (
        <ActionForm op="projectDraft.test" submit="Run the tests again" pendingLabel="Running the tests…" statusUrl={status} lock="project" secondary>
          <input type="hidden" name="draft" value={d.id} />
          <input type="hidden" name="again" value="1" />
        </ActionForm>
      )}

      {!problems.length && (
        <div className="create-approval">
          {ready.warnings.map((w) => <p key={w} className="notes"><I icon={TriangleAlert} size={14} /> {w}</p>)}
          <p>When you approve, the tested files are copied into <code>{ready.target}</code> and checked against what was tested. Only then is the project added to the library{dec.components.length ? `, with ${dec.components.map((c) => `${c.name} ${c.version}`).join(" and ")} recorded as connected` : ""}. If anything fails, the folder is removed and nothing is recorded.</p>
          <ActionForm op="projectDraft.create" submit="Approve: create project" pendingLabel="Creating the project…" statusUrl={status} lock="project">
            <input type="hidden" name="draft" value={d.id} />
          </ActionForm>
        </div>
      )}
    </Card>
  );
}

function FixWithAI({ d, status, next }: { d: ProjectDraft; status: string; next: "build" | "test" }) {
  const b = d.build!;
  const f = getLib().projectCreation.freshness(d);
  const t = f.tests === "current" ? d.tests : null;
  const failed = t && t.status !== "passed";
  const notConnected = Object.entries(getLib().projectCreation.connections(d)).filter(([, s]) => !s.connected && t).map(([slug, s]) => `${slug}: ${s.why}`);
  const auto = b.problems.length ? `The checks found: ${b.problems.join(" ")}`
    : failed ? `The tests ${t.status}. Output:\n${(t.stderr || t.stdout).slice(-3000)}`
    : notConnected.length ? `These components aren't connected: ${notConnected.join(" ")}` : "";
  return (
    <details className={auto ? "reveal fix" : "more fix"} open={!!auto}>
      <summary className={auto ? "button secondary" : undefined}>{auto ? <><I icon={Sparkles} size={16} /> Fix</> : <><I icon={Sparkles} size={16} /> Make a change</>}</summary>
      <ActionForm op="projectDraft.build" submit="Approve and rebuild" pendingLabel="Rebuilding the project…" statusUrl={status} lock="project">
        <input type="hidden" name="draft" value={d.id} />
        <input type="hidden" name="next" value={next} />
        <label>What should change?<textarea name="feedback" className="plain" rows={auto ? 6 : 3} required defaultValue={auto} /></label>
      </ActionForm>
      <p className="hint">The new files replace these, and the tests need to run again.</p>
    </details>
  );
}
