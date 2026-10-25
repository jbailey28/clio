import Link from "next/link";
import type { ReactNode } from "react";
import { getLib } from "@/src/web/lib";
import { ActionForm, LiveActivity } from "@/src/ui/client";
import { ConfirmAction } from "@/src/ui/confirm";
import { Ago, Flash, TestBadge, orNotFound, type SP } from "@/src/ui/server";
import { ArrowLeft, ChevronRight, CircleAlert, CircleCheck, FileText, I, Package, ShieldCheck, Sparkles, TriangleAlert, categoryIcon } from "@/src/ui/icons";
import type { Draft, SimilarComponent, Stage } from "@/src/core";

export const dynamic = "force-dynamic";

const STEPS: { key: Stage | "describe"; label: string }[] = [
  { key: "describe", label: "Describe" }, { key: "proposed", label: "Review" }, { key: "generated", label: "Generate" },
  { key: "tested", label: "Test" }, { key: "released", label: "Add to library" },
];

export default async function DraftPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const lib = getLib();
  const d = orNotFound(() => lib.creation.get(id));
  const stage = lib.creation.stage(d);
  const active = lib.creation.active(d); // only a step the server confirms is still running
  const here = `/create/${d.id}`;
  const current = d.proposal ? (stage === "asking" ? 1 : STEPS.findIndex((s) => s.key === stage)) : 0;

  return (
    <>
      <Link href="/create" className="crumb"><I icon={ArrowLeft} size={16} /> Create a component</Link>
      <header className="page-head" style={{ marginBottom: 16 }}>
        <div>
          <h1>{d.choice.name || "New component"}</h1>
          <ol className="steps" aria-label="Progress">
            {STEPS.map((s, i) => (
              <li key={s.key} className={i < current ? "done" : i === current ? "now" : undefined} aria-current={i === current ? "step" : undefined}>{s.label}</li>
            ))}
          </ol>
        </div>
      </header>
      <Flash sp={sp} />
      {active && <LiveActivity statusUrl={statusOf(d)} step={active.step} detail={active.detail} lock="draft" />}
      {d.lastError && !sp.error && !active && (
        <p className="flash error" role="alert"><strong>{cap(d.lastError.step)} didn't work.</strong> {d.lastError.message}</p>
      )}

      <Section title="Your description">
        <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{d.prompt}</p>
        {d.answers.map((a) => <p key={a.question} className="hint"><strong>{a.question}</strong> {a.answer}</p>)}
      </Section>

      {!d.proposal && <NoProposal d={d} />}
      {d.proposal && stage === "asking" && <Questions d={d} />}
      {d.proposal && stage !== "asking" && <ProposalView d={d} stage={stage} />}
      {d.generation && <Generated d={d} stage={stage} />}
      {d.generation?.checks.ok && <Tests d={d} stage={stage} />}
      {stage === "tested" && <Release d={d} />}
      {stage === "released" && d.component && (
        <Section title="In the library" icon={Package}>
          <p style={{ marginTop: 0 }}>Released as version {d.component.version}.</p>
          <Link href={`/components/${d.component.slug}`} className="button">Open {d.choice.name}</Link>
        </Section>
      )}

      {stage !== "released" && (
        <section style={{ marginTop: 32 }} aria-label="Discard">
          <ConfirmAction lock="draft" op="create.discard" fields={{ draft: d.id }} trigger="Discard this draft" title="Discard this draft?" confirmLabel="Discard" pendingLabel="Discarding…" returnTo={here}>
            <p>The draft and its generated files are deleted. Nothing in your library changes.</p>
          </ConfirmAction>
        </section>
      )}
    </>
  );
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const statusOf = (d: Draft) => `/api/create/status?draft=${d.id}`;

function Section({ title, icon, children, tone }: { title: string; icon?: typeof Package; children: ReactNode; tone?: "warn" }) {
  return (
    <section className={`card draft-section${tone ? ` ${tone}` : ""}`} aria-label={title}>
      <h2 className="panel-title" style={{ justifyContent: "flex-start", gap: 8 }}>{icon && <I icon={icon} size={18} />}{title}</h2>
      {children}
    </section>
  );
}

function NoProposal({ d }: { d: Draft }) {
  return (
    <Section title="Proposal">
      <p style={{ marginTop: 0 }} className="muted">{getLib().creation.active(d) ? "The proposal is being written." : "There's no proposal yet."}</p>
      {!getLib().creation.active(d) && (
        <ActionForm statusUrl={statusOf(d)} lock="draft" op="create.retry" submit="Try again" pendingLabel="Checking your library and writing the proposal…">
          <input type="hidden" name="draft" value={d.id} />
        </ActionForm>
      )}
    </Section>
  );
}

function Questions({ d }: { d: Draft }) {
  return (
    <Section title="A few questions first">
      <p className="hint" style={{ marginTop: 0 }}>Your description leaves something open. Answer briefly and the proposal is written next.</p>
      <ActionForm statusUrl={statusOf(d)} lock="draft" op="create.answer" submit="Continue" pendingLabel="Writing the proposal…">
        <input type="hidden" name="draft" value={d.id} />
        {d.proposal!.questions.map((q, i) => (
          <label key={q} style={{ color: "var(--text)", fontSize: 14 }}>{q}<input name={`answer_${i}`} required /></label>
        ))}
      </ActionForm>
    </Section>
  );
}

function ProposalView({ d, stage }: { d: Draft; stage: Stage }) {
  const lib = getLib();
  const p = d.proposal!;
  const cats = lib.categories.list();
  const recommended = p.category.slug && cats.some((c) => c.slug === p.category.slug) ? p.category.slug : null;
  const locked = !!d.generation;
  const { components } = lib.creation.similar(d);
  const strong = components.filter((m) => m.verdict === "same");
  const partial = components.filter((m) => m.verdict === "partial");
  // "different" means it only shares words with the request: never shown as related.
  const blockers = lib.creation.readyToGenerate(d);

  return (
    <>
      <ExistingCheck same={strong} partial={partial} />

      <Section title="Proposal">
        {/* Keyed on what's saved, so the fields redraw after a change made by another form (like New category). */}
        <ActionForm key={`${d.choice.category}|${d.choice.name}|${d.updatedAt}`} lock="draft" op="create.edit" submit="Save changes" pendingLabel="Saving…" returnTo={`/create/${d.id}`}>
          <input type="hidden" name="draft" value={d.id} />
          <label>Name
            {locked ? <input value={d.choice.name} readOnly aria-describedby="name-locked" /> : <input name="name" defaultValue={d.choice.name} required maxLength={80} />}
          </label>
          {locked && <span id="name-locked" className="hint">The name is fixed once code is generated, because it names the code.</span>}
          <label>What it will do<textarea name="summary" className="plain" defaultValue={d.choice.summary} required rows={3} /></label>
          <label>Category
            <select name="category" defaultValue={d.choice.category} required>
              <option value="" disabled>Choose a category</option>
              {cats.map((c) => <option key={c.id} value={c.slug}>{c.name}{c.slug === recommended ? " (recommended)" : ""}</option>)}
            </select>
          </label>
          {p.category.reason && <span className="hint">{recommended ? "Recommended because: " : "No existing category fits well: "}{p.category.reason}</span>}
        </ActionForm>
        <details className="reveal" open={!d.choice.category && !!p.category.newName}>
          <summary className="button secondary">New category</summary>
          <ActionForm lock="draft" op="create.newCategory" submit="Create category and choose it" pendingLabel="Creating…" returnTo={`/create/${d.id}`}>
            <input type="hidden" name="draft" value={d.id} />
            <label>Category name<input name="name" required defaultValue={!recommended ? p.category.newName ?? "" : ""} /></label>
            <label>Description (optional)<input name="description" /></label>
          </ActionForm>
          <p className="hint">Only created when you press the button. It stays even if you discard this draft.</p>
        </details>

        <dl className="plan">
          <dt>Inputs</dt><dd>{list(p.inputs)}</dd>
          <dt>Outputs</dt><dd>{list(p.outputs)}</dd>
          <dt>How it will work</dt><dd>{p.approach}</dd>
          <dt>Dependencies</dt>
          <dd>{p.needsPackages.length
            ? <span className="bad-text">Needs {p.needsPackages.join(", ")}, outside Python's standard library. Packages are never installed automatically, so this can't be built here yet.</span>
            : "None. Python's standard library only, so nothing needs installing."}</dd>
          <dt>Tests</dt><dd>{p.tests}</dd>
        </dl>
        <details>
          <summary className="hint" style={{ cursor: "pointer" }}>Technical details</summary>
          <p className="hint">Python 3.9, standard library only. Tests use Python's built-in unittest and run in a sandbox with no network and no access to your files. Capabilities: {p.capabilities.map((c) => c.name).join(", ") || "none listed"}.</p>
        </details>
      </Section>

      {stage === "proposed" && (
        <Section title="Generate the code" icon={Sparkles}>
          {blockers.length ? (
            <ul className="problems">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          ) : (
            <>
              <p style={{ marginTop: 0 }} className="muted">The code is written into this draft's own staging folder and checked for safety. Nothing runs, and nothing is added to the library yet.</p>
              <ActionForm statusUrl={statusOf(d)} lock="draft" op="create.generate" submit={strong.length ? "Generate anyway" : "Approve and generate code"} pendingLabel="Generating code… this usually takes under 2 minutes">
                <input type="hidden" name="draft" value={d.id} />
              </ActionForm>
            </>
          )}
        </Section>
      )}
    </>
  );
}

/**
 * The library check, as one result: an existing component that already does
 * this, or none. Components that do part of it are listed under it as related.
 * Components the AI judged to do a different job are not shown.
 */
function ExistingCheck({ same, partial }: { same: SimilarComponent[]; partial: SimilarComponent[] }) {
  return (
    <section className={`card draft-section existing${same.length ? " found" : ""}`} aria-label="Library check">
      {same.length ? (
        <>
          <p className="existing-result"><I icon={CircleAlert} size={20} className="warn-icon" /> Existing match found</p>
          <p className="hint" style={{ margin: "4px 0 12px 32px" }}>{same.length === 1 ? "This component already does what you described. Reuse it instead of building a second one." : "These components already do what you described. Reuse one instead of building another."}</p>
          <ul className="related-rows">{same.map((m) => <Row key={m.slug} m={m} label="Same job" />)}</ul>
        </>
      ) : (
        <p className="existing-result"><I icon={CircleCheck} size={20} className="ok-icon" /> No existing components found</p>
      )}
      {partial.length > 0 && (
        <>
          <hr className="divider-line" />
          <h2 className="related-title"><span>Related components</span><span className="faint small">{partial.length} found</span></h2>
          <ul className="related-rows">{partial.map((m) => <Row key={m.slug} m={m} label="Partial match" />)}</ul>
        </>
      )}
    </section>
  );
}

const firstSentence = (s: string) => (s.match(/^.*?[.!?](\s|$)/)?.[0] ?? s).trim();

function Row({ m, label }: { m: SimilarComponent; label: string }) {
  return (
    <li>
      <Link href={`/components/${m.slug}`} className="related-row">
        <I icon={categoryIcon(m.categoryName)} size={18} className="muted" />
        <span className="body">
          <span className="name"><strong>{m.name}</strong> <span className={`badge${label === "Same job" ? " accent" : ""}`}>{label}</span></span>
          <span className="desc">{firstSentence(m.summary || m.covers)}</span>
        </span>
        <I icon={ChevronRight} className="muted" />
      </Link>
    </li>
  );
}

const list = (items: { name: string; description: string }[]) =>
  items.length ? <ul style={{ margin: 0, paddingLeft: 18 }}>{items.map((i) => <li key={i.name}><strong>{i.name}</strong>{i.description && <>: {i.description}</>}</li>)}</ul> : "None";

function Generated({ d, stage }: { d: Draft; stage: Stage }) {
  const g = d.generation!;
  const files = getLib().creation.files(d);
  return (
    <Section title={`Generated files${g.attempt > 1 ? ` (attempt ${g.attempt})` : ""}`} icon={FileText}>
      <p className="hint" style={{ marginTop: 0 }}>Written <Ago iso={g.at} /> into this draft's staging folder. Open a file to read it.</p>
      <ul className="rows">
        {files.map((f) => (
          <li key={f.path}>
            <details className="file">
              <summary><I icon={FileText} size={16} /> <code>{f.path}</code> <span className="faint small">{g.files.find((x) => x.path === f.path)?.bytes.toLocaleString()} bytes</span></summary>
              <pre>{f.content}</pre>
            </details>
          </li>
        ))}
      </ul>
      <h3>Safety checks</h3>
      {g.checks.ok
        ? <p className="ok-text" style={{ marginTop: 0 }}><I icon={ShieldCheck} size={16} /> Passed: files only inside the component, nothing that looks like a password or key, standard library only{g.checks.imports.length ? ` (${g.checks.imports.join(", ")})` : ""}.</p>
        : <ul className="problems">{g.checks.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      {g.checks.notes.length > 0 && <ul className="notes">{g.checks.notes.map((n) => <li key={n}><I icon={TriangleAlert} size={14} /> {n}</li>)}</ul>}
      {!g.checks.ok && <p className="hint">Its code will not be run until these are fixed.</p>}
      {stage !== "released" && <Regenerate d={d} />}
    </Section>
  );
}

function Regenerate({ d }: { d: Draft }) {
  const failed = d.tests && d.tests.status !== "passed";
  const checksFailed = !d.generation!.checks.ok;
  const auto = failed ? `The tests ${d.tests!.status}. Output:\n${(d.tests!.stderr || d.tests!.stdout).slice(-3000)}`
    : checksFailed ? `The safety checks found: ${d.generation!.checks.problems.join(" ")}` : "";
  return (
    <details className="reveal" open={!!auto} style={{ marginTop: 16 }}>
      <summary className="button secondary">{auto ? <><I icon={Sparkles} size={16} /> Fix</> : <><I icon={Sparkles} size={16} /> Make a change</>}</summary>
      <ActionForm statusUrl={statusOf(d)} lock="draft" op="create.generate" submit="Approve and regenerate" pendingLabel="Fixing the code…">
        <input type="hidden" name="draft" value={d.id} />
        <label>What should change?<textarea name="feedback" className="plain" rows={auto ? 6 : 3} required defaultValue={auto} /></label>
      </ActionForm>
      <p className="hint">The new files replace these. Earlier test results no longer count.</p>
    </details>
  );
}

function Tests({ d, stage }: { d: Draft; stage: Stage }) {
  const t = d.tests;
  return (
    <Section title="Tests" icon={ShieldCheck}>
      {t && (
        <>
          <p style={{ marginTop: 0 }}><TestBadge status={t.status} /> <Ago iso={t.at} /> · {(t.durationMs / 1000).toFixed(1)}s · exit {t.exitCode ?? "none"}
            {stage !== "tested" && t.status === "passed" && <> · <span className="bad-text">the files changed since, so run them again</span></>}</p>
          <details open={t.status !== "passed"}><summary className="hint" style={{ cursor: "pointer" }}>Test output</summary><pre>{(t.stderr + "\n" + t.stdout).trim() || "(no output)"}</pre></details>
        </>
      )}
      {stage === "generated" && (
        <>
          <p className="muted">Runs the component's own tests in a sandbox: no network, no access to your files, and it can only write to a temporary folder that is deleted afterwards.</p>
          <ActionForm statusUrl={statusOf(d)} lock="draft" op="create.test" submit={t ? "Approve and run the tests again" : "Approve and run tests"} pendingLabel="Running tests in the sandbox…">
            <input type="hidden" name="draft" value={d.id} />
          </ActionForm>
        </>
      )}
    </Section>
  );
}

function Release({ d }: { d: Draft }) {
  const cat = getLib().categories.list().find((c) => c.slug === d.choice.category);
  return (
    <Section title="Add to the library" icon={Package}>
      <p style={{ marginTop: 0 }}>Review the files above. When you approve:</p>
      <ol style={{ marginTop: 0 }}>
        <li>The files are copied into the library as <strong>{d.choice.name}</strong> in <strong>{cat?.name ?? "(no category)"}</strong>.</li>
        <li>The same tests run again, in the sandbox, on the library's copy.</li>
        <li>Only if they pass, version 1.0.0 is released: a frozen, read-only copy with checksums.</li>
      </ol>
      <ActionForm statusUrl={statusOf(d)} lock="draft" op="create.register" submit="Approve: add to the library and release 1.0.0" pendingLabel="Adding it to the library…">
        <input type="hidden" name="draft" value={d.id} />
      </ActionForm>
    </Section>
  );
}
