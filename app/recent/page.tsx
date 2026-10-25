import Link from "next/link";
import { getLib } from "@/src/web/lib";
import { Ago, Empty, PageHead, TestBadge } from "@/src/ui/server";
import { ChevronRight, I, categoryIcon } from "@/src/ui/icons";

export const dynamic = "force-dynamic";

export default function Recent() {
  const items = getLib().components.recent(50);
  return (
    <>
      <PageHead title="Recently Used" subtitle="Components you viewed, edited, tested, released or added to a project, newest first." />
      {items.length ? (
        <ul className="rows">
          {items.map((c) => (
            <li key={c.id}>
              <Link href={`/components/${c.slug}`} className="row-link">
                <span className="tile sm"><I icon={categoryIcon(c.categoryName)} size={18} /></span>
                <span className="body">
                  <strong>{c.name}</strong>
                  <div className="desc">{c.categoryName} · last action: {c.lastAction}</div>
                </span>
                <span className="meta"><Ago iso={c.lastActionAt} /></span>
                <TestBadge status={c.lastTestStatus} />
                <I icon={ChevronRight} className="muted" />
              </Link>
            </li>
          ))}
        </ul>
      ) : <Empty title="Nothing used yet."><p>Open a component and it shows up here.</p></Empty>}
    </>
  );
}
