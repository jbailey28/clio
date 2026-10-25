"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Progress, holdLock, useLocked, usePolledStatus } from "./client";
import { CircleAlert, I, Plus, Sparkles, Undo2, X } from "./icons";
import type { Need, PlannedComponent, ProjectPlan } from "@/src/core/projectCreation";

/**
 * The editable parts of "Create project": the plan (step 2) and the
 * components checklist (step 3). Edits save as you make them; nothing here
 * asks the AI unless a button says so.
 */

type Reply = { ok: boolean; redirect?: string; error?: string };

async function post(op: string, fields: Record<string, string>): Promise<Reply> {
  const body = new FormData();
  body.set("op", op);
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  try {
    const res = await fetch("/api/do", { method: "POST", body, headers: { "x-fetch": "1" } });
    return await res.json().catch(() => ({ ok: false, error: `The server answered ${res.status} without details.` }));
  } catch (err) {
    return { ok: false, error: `Could not reach the app server: ${(err as Error).message}` };
  }
}

/** Saves after a short pause; `flush` saves now and reports whether it worked. */
function useAutosave(save: () => Promise<Reply>, deps: unknown[]) {
  const router = useRouter();
  const [state, setState] = useState<"saved" | "saving" | "error">("saved");
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  const first = useRef(true);
  const saveRef = useRef(save);
  saveRef.current = save;

  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (!dirty.current) return true;
    dirty.current = false;
    setState("saving");
    const r = await saveRef.current();
    setState(r.ok ? "saved" : "error");
    setError(r.ok ? null : r.error ?? "It couldn't be saved.");
    if (!r.ok) dirty.current = true;
    else router.refresh(); // the step bar and later steps follow the saved inputs; the editor keeps what's typed
    return r.ok;
  }, [router]);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    dirty.current = true;
    setState("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { state, error, flush };
}

function SaveState({ state, error }: { state: string; error: string | null }) {
  if (state === "error") return <p className="save-state bad-text" role="alert">Not saved: {error}</p>;
  return <p className="save-state hint" aria-live="polite">{state === "saving" ? "Saving…" : "Saved"}</p>;
}

/** One running AI request at a time for the draft, with the shared progress indicator. */
function useRun(statusUrl: string) {
  const router = useRouter();
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locked = useLocked("project");
  const { detail } = usePolledStatus(statusUrl, !!running);
  const run = async (label: string, before: () => Promise<boolean>, op: string, fields: Record<string, string>, onOk?: (r: Reply) => void) => {
    if (running || locked) return;
    setError(null);
    setRunning(label);
    holdLock("project", 1);
    try {
      if (!(await before())) return;
      const r = await post(op, fields);
      if (!r.ok) { setError(r.error ?? "That didn't work."); return; }
      if (onOk) onOk(r); else { router.push(r.redirect!); router.refresh(); }
    } finally {
      holdLock("project", -1);
      setRunning(null);
    }
  };
  return { run, running, error, detail, busy: !!running || locked };
}

// ---------- step 2: the plan ----------

type Row = { id?: string; text: string; included: boolean; origin: "asked" | "suggested" | "you" };

const ORIGIN: Record<Row["origin"], string> = { asked: "From your description", suggested: "Suggested", you: "Added by you" };

export function PlanEditor({ draftId, plan, statusUrl, undo, refined, componentsCurrent, readOnly }: {
  draftId: string;
  plan: ProjectPlan;
  statusUrl: string;
  /** What the last AI change was, in words, when it can be undone. */
  undo: string | null;
  refined: { instruction: string; changes: string[] } | null;
  componentsCurrent: boolean;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState(plan.name);
  const [description, setDescription] = useState(plan.description);
  const [rows, setRows] = useState<Row[]>(plan.features.map((f) => ({ id: f.id, text: f.text, included: f.included, origin: f.origin })));
  const [adding, setAdding] = useState("");
  const [instruction, setInstruction] = useState("");
  const { run, running, error, detail, busy } = useRun(statusUrl);

  const payload = () => JSON.stringify({ name, description, features: rows.map((r) => ({ id: r.id, text: r.text, included: r.included })) });
  const { state, error: saveError, flush } = useAutosave(() => post("projectDraft.savePlan", { draft: draftId, plan: payload() }), [name, description, rows]);
  const lock = readOnly || busy;

  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = () => {
    const t = adding.trim();
    if (!t) return;
    setRows((rs) => [...rs, { text: t, included: true, origin: "you" }]);
    setAdding("");
  };
  const none = !rows.some((r) => r.included && r.text.trim());

  return (
    <div className="plan-editor">
      {undo && (
        <div className="refined" role="status">
          <span className="refined-text"><I icon={Sparkles} size={16} /><span><strong>Plan changed.</strong> {refined ? `${refined.changes.join(". ")}.` : undo}</span></span>
          <button type="button" className="secondary" disabled={lock}
            onClick={() => run("undo", flush, "projectDraft.undo", { draft: draftId })}><I icon={Undo2} size={16} /> Undo</button>
        </div>
      )}

      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required disabled={readOnly} /></label>
      <label>Description<textarea className="plain" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} disabled={readOnly} /></label>
      {plan.technology && <p className="hint tech">Built as {plan.technology.replace(/^./, (c) => c.toLowerCase())}.</p>}

      <fieldset className="features">
        <legend>What it will do</legend>
        <ul>
          {rows.map((r, i) => (
            <li key={r.id ?? `new-${i}`} className={r.included ? undefined : "off"}>
              <input type="checkbox" checked={r.included} onChange={(e) => setRow(i, { included: e.target.checked })} disabled={readOnly}
                aria-label={`Include “${r.text}”`} />
              <span className="feature-card">
                <input className="feature-text" value={r.text} onChange={(e) => setRow(i, { text: e.target.value })} maxLength={200} disabled={readOnly}
                  aria-label={`Feature ${i + 1}`} />
                <span className="origin">{ORIGIN[r.origin]}</span>
                {!readOnly && <button type="button" className="icon-button" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                  aria-label={`Remove “${r.text}”`} title="Remove"><I icon={X} size={14} /></button>}
              </span>
            </li>
          ))}
        </ul>
        {!readOnly && (
          <div className="add-feature">
            <input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Add a feature" aria-label="New feature" maxLength={200}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
            <button type="button" className="secondary" onClick={add} disabled={!adding.trim()}><I icon={Plus} size={16} /> Add</button>
          </div>
        )}
        {none && <p className="bad-text small">Keep at least one feature, so there is something to build.</p>}
      </fieldset>
      {!readOnly && <SaveState state={state} error={saveError} />}

      {!readOnly && (
        <div className="refine">
          <label htmlFor="refine"><I icon={Sparkles} size={16} className="ai-icon" /> Make a change to the plan</label>
          <div className="refine-row">
            <textarea id="refine" className="plain" rows={2} value={instruction} onChange={(e) => setInstruction(e.target.value)} maxLength={1000}
              placeholder="For example: make it a web page instead, and drop the email." disabled={lock} />
            <button type="button" className="secondary" disabled={lock || instruction.trim().length < 3}
              onClick={() => run("refine", flush, "projectDraft.refine", { draft: draftId, instruction }, () => { setInstruction(""); router.refresh(); })}>
              <I icon={Sparkles} size={16} /> Change the plan
            </button>
          </div>
          <p className="hint">Only what you ask for changes. Your own edits stay, and you can undo it.</p>
        </div>
      )}

      {error && <p className="flash error" role="alert"><strong>That didn't work.</strong> {error}</p>}
      {running && running !== "undo" && <Progress message={detail ?? (running === "refine" ? "Changing the plan…" : "Matching your plan to your components…")} />}

      <div className="step-actions">
        <button type="button" disabled={lock || none || !name.trim()}
          onClick={() => componentsCurrent
            ? flush().then((ok) => { if (ok) router.push(`/projects/create/${draftId}?step=components`); })
            : run("analyze", flush, "projectDraft.analyze", { draft: draftId })}>
          {running === "analyze" ? "Working…" : "Continue to components"}
        </button>
      </div>
    </div>
  );
}

// ---------- step 3: the components checklist ----------

type Status = "available" | "partial" | "build" | "setup" | "left-out";
const STATUS: Record<Status, string> = {
  available: "Available in library", partial: "Partly covered", build: "Will be built in project", setup: "Setup needed", "left-out": "Left out",
};

export function ComponentsEditor({ draftId, needs, components, useComponent, includeNeed, readOnly }: {
  draftId: string;
  needs: Need[];
  components: PlannedComponent[];
  useComponent: Record<string, boolean>;
  includeNeed: Record<string, boolean>;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [use, setUse] = useState(useComponent);
  const [keep, setKeep] = useState(includeNeed);
  const { state, error, flush } = useAutosave(() => post("projectDraft.choose", { draft: draftId, choice: JSON.stringify({ useComponent: use, includeNeed: keep }) }), [use, keep]);
  const locked = useLocked("project");
  const bySlug = new Map(components.map((c) => [c.slug, c]));

  const statusOf = (n: Need): Status => {
    if (!n.required && keep[n.id] === false) return "left-out";
    const c = n.component ? bySlug.get(n.component) : undefined;
    if (c && (c.problems.length || use[c.slug] === false)) return "build";
    return n.status;
  };

  return (
    <div className="components-editor">
      <ul className="needs">
        {needs.map((n) => {
          const s = statusOf(n);
          const c = n.component ? bySlug.get(n.component) : undefined;
          const on = !!c && !c.problems.length && use[c.slug] !== false;
          return (
            <li key={n.id} className={`need${s === "left-out" ? " off" : ""}`}>
              <div className="need-head">
                <span className={`badge status-${s}`}>{STATUS[s]}</span>
                <strong>{n.need}</strong>
                {n.required ? <span className="need-req alert-text"><I icon={CircleAlert} size={14} /> Needed</span> : (
                  <label className="switch">
                    <input type="checkbox" role="switch" checked={keep[n.id] !== false} disabled={readOnly}
                      onChange={(e) => setKeep((k) => ({ ...k, [n.id]: e.target.checked }))} aria-label={`Include ${n.need}`} />
                    <span>Include</span>
                  </label>
                )}
              </div>
              {n.why && <p className="desc">{n.why}</p>}
              {s === "setup" && n.steps && <p className="desc">You'll need to: {n.steps}</p>}
              {c && s !== "left-out" && (
                <div className={`need-component${on ? "" : " off"}`}>
                  <div className="need-head">
                    <Link href={`/components/${c.slug}`}><strong>{c.name}</strong></Link>
                    <span className="faint small">{c.version}</span>
                    <label className="switch">
                      <input type="checkbox" role="switch" checked={on} disabled={readOnly || !!c.problems.length}
                        onChange={(e) => setUse((u) => ({ ...u, [c.slug]: e.target.checked }))} aria-label={`Use ${c.name}`} />
                      <span>Use</span>
                    </label>
                  </div>
                  {c.contributes && <p className="desc">What it does here: {c.contributes}</p>}
                  {c.evidence.functions.length > 0 && <p className="evidence">Calls {c.evidence.functions.map((f) => `${f.name}${f.signature}`).join(", ")}</p>}
                  {n.limits && <p className="desc">It doesn't: {n.limits}</p>}
                  {c.problems.map((x) => <p key={x} className="bad-text small">{x}</p>)}
                  {!on && !c.problems.length && (
                    <p className="instead" role="status">
                      {n.ifLeftOut ? `Instead, this will be built in the project: ${n.ifLeftOut}` : `Instead, ${n.need.replace(/^./, (x) => x.toLowerCase())} will be built in the project.`}
                      {n.required && <span className="alert-text"> This is needed for the project to work. To drop it, <Link href={`/projects/create/${draftId}?step=plan`}>change the plan</Link>.</span>}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {!readOnly && <SaveState state={state} error={error} />}
      <div className="step-actions">
        <button type="button" disabled={locked || readOnly}
          onClick={() => flush().then((ok) => { if (ok) { router.push(`/projects/create/${draftId}?step=build`); router.refresh(); } })}>
          Continue to build
        </button>
      </div>
    </div>
  );
}
