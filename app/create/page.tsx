import Link from "next/link";
import { getLib } from "@/src/web/lib";
import { ActionForm } from "@/src/ui/client";
import { Dictation } from "@/src/ui/dictation";
import { Ago, Empty, Flash, PageHead, type SP } from "@/src/ui/server";
import { ArrowLeft, ChevronRight, I, Sparkles, TriangleAlert } from "@/src/ui/icons";

export const dynamic = "force-dynamic";

const STAGE_LABEL = { asking: "Waiting for your answers", proposed: "Proposal ready for review", generated: "Code generated, not tested", tested: "Tests passed, ready to add", released: "In the library" } as const;

export default async function CreatePage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const lib = getLib();
  const ai = lib.creation.provider();
  const drafts = lib.creation.list();
  return (
    <>
      <Link href="/" className="crumb"><I icon={ArrowLeft} size={16} /> Home</Link>
      <PageHead title="Create a component" subtitle="Describe what you want in your own words. You'll review a proposal before anything is built." />
      <Flash sp={sp} />
      {!ai.available && (
        <p className="flash error" role="alert"><I icon={TriangleAlert} size={16} /> {ai.name} is {ai.detail}, so components can't be generated right now.</p>
      )}
      <section className="card describe" aria-labelledby="describe-title">
        <ActionForm op="create.start" submit="Continue" pendingLabel="Checking your library and writing the proposal… this can take up to a minute">
          <label htmlFor="prompt" id="describe-title" className="describe-title">Describe the component you want to build.</label>
          <textarea id="prompt" name="prompt" required minLength={10} maxLength={4000} rows={5} className="prompt"
            placeholder="I want a component that takes a website URL, identifies what ecommerce platform it uses, and returns the result with evidence." />
          <Dictation target="prompt" />
        </ActionForm>
      </section>
      <p className="hint" style={{ marginTop: 16 }}>
        Already have the code? <Link href="/components/new">Add existing component</Link>
      </p>

      <h2>Unfinished drafts</h2>
      {drafts.length ? (
        <ul className="rows">
          {drafts.map((d) => (
            <li key={d.id}>
              <Link href={`/create/${d.id}`} className="row-link">
                <span className="tile sm"><I icon={Sparkles} size={18} /></span>
                <span className="body">
                  <strong>{d.choice.name || "Untitled draft"}</strong>
                  <div className="desc">{d.prompt.slice(0, 140)}{d.prompt.length > 140 ? "…" : ""}</div>
                </span>
                <span className="meta">{lib.creation.active(d) ? `Working: ${lib.creation.active(d)!.detail ?? d.busy!.step}` : d.lastError ? "Needs attention" : STAGE_LABEL[lib.creation.stage(d)]}</span>
                <span className="meta"><Ago iso={d.updatedAt} /></span>
                <I icon={ChevronRight} className="muted" />
              </Link>
            </li>
          ))}
        </ul>
      ) : <Empty title="No unfinished drafts." />}
    </>
  );
}
