import Link from "next/link";
import { getLib } from "@/src/web/lib";
import { ActionForm } from "@/src/ui/client";
import { Dictation } from "@/src/ui/dictation";
import { Ago, Empty, Flash, PageHead, StepBar, type SP } from "@/src/ui/server";
import { ArrowLeft, ChevronRight, I, Sparkles, TriangleAlert } from "@/src/ui/icons";

export const dynamic = "force-dynamic";

export default async function CreateProjectPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const lib = getLib();
  const ai = lib.creation.provider();
  const root = lib.projectCreation.root();
  const drafts = lib.projectCreation.list();
  return (
    <>
      <Link href="/projects/new" className="crumb"><I icon={ArrowLeft} size={16} /> Add a project</Link>
      <PageHead title="Create project" subtitle="Describe what you want to build. You'll review the plan, the components and every file before anything is created." />
      <StepBar current={0} />
      <Flash sp={sp} />
      {!ai.available && <p className="flash error" role="alert"><I icon={TriangleAlert} size={16} /> {ai.name} is {ai.detail}, so projects can't be planned right now. You can still <Link href="/projects/add">add an existing project</Link>.</p>}
      <section className="card describe" aria-labelledby="describe-title">
        <ActionForm op="projectDraft.start" submit="Continue" pendingLabel="Planning the project… this can take up to a minute">
          <label htmlFor="prompt" id="describe-title" className="describe-title">Describe the project you want to build.</label>
          <textarea id="prompt" name="prompt" required minLength={10} maxLength={4000} rows={5} className="prompt"
            placeholder="A small tool that reads my Instagram export and makes a weekly summary of posts, likes and comments." />
          <Dictation target="prompt" />
          <p className="hint" style={{ margin: 0 }}>
            New projects go in <code>{root.path}</code> (Settings → Projects Location). {ai.name} only answers; it can't read or change anything on your Mac.
          </p>
        </ActionForm>
      </section>
      {root.iCloud && <p className="flash error" role="alert" style={{ marginTop: 16 }}>{root.iCloud}</p>}

      <h2>Unfinished plans</h2>
      {drafts.length ? (
        <ul className="rows">
          {drafts.map((d) => (
            <li key={d.id}>
              <Link href={`/projects/create/${d.id}`} className="row-link">
                <span className="tile sm"><I icon={Sparkles} size={18} /></span>
                <span className="body"><strong>{d.plan?.name || "Untitled plan"}</strong><div className="desc">{d.prompt.slice(0, 140)}{d.prompt.length > 140 ? "…" : ""}</div></span>
                <span className="meta">{lib.creation.active(d) ? "Working…" : d.legacy ? "Made with an earlier version" : d.lastError ? "Needs attention" : d.plan ? "In progress" : "No plan yet"}</span>
                <span className="meta"><Ago iso={d.updatedAt} /></span>
                <I icon={ChevronRight} className="muted" />
              </Link>
            </li>
          ))}
        </ul>
      ) : <Empty title="No unfinished plans." />}
    </>
  );
}
