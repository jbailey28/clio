import Link from "next/link";
import { Flash, PageHead, type SP } from "@/src/ui/server";
import { ArrowLeft, FolderOpen, I, Puzzle } from "@/src/ui/icons";

export default async function AddProject({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  return (
    <>
      <Link href="/projects" className="crumb"><I icon={ArrowLeft} size={16} /> My Projects</Link>
      <PageHead title="Add a project" subtitle="Start a new project, or connect one that's already on your Mac." />
      <Flash sp={sp} />
      <div className="choice-grid">
        <Link href="/projects/create" className="card choice">
          <I icon={Puzzle} size={22} className="muted" />
          <strong>Create project</strong>
          <span className="desc">Describe what you want to build and get help setting it up.</span>
        </Link>
        <Link href="/projects/add" className="card choice">
          <I icon={FolderOpen} size={22} className="muted" />
          <strong>Add existing project</strong>
          <span className="desc">Find a project already on your computer and connect it to your library.</span>
        </Link>
      </div>
    </>
  );
}
