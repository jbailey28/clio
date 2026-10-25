import Link from "next/link";
import { getLib } from "@/src/web/lib";
import { SearchField, ShowMore } from "@/src/ui/client";
import { CategoryCard, Empty, Flash, MatchList, PageHead, type SP } from "@/src/ui/server";
import { I, Sparkles } from "@/src/ui/icons";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const lib = getLib();
  const categories = lib.categories.list();

  return (
    <>
      <PageHead title="Component Library" />
      <Flash sp={sp} />
      <div className="search-row">
        <form action="/" method="get" role="search">
          <SearchField defaultValue={q} label="Search components, categories, or functionality"
            placeholder="Search components, categories, or functionality..." shortcut />
        </form>
        <Link href="/create" className="button create"><I icon={Sparkles} size={18} /> Create component</Link>
      </div>

      {q ? (
        <>
          {(() => {
            const cats = lib.categories.list(q);
            return (
              <>
                <h2>Categories matching “{q}”</h2>
                {cats.length ? <div className="grid">{cats.map((c) => <CategoryCard key={c.id} c={c} />)}</div>
                  : <p className="muted">No categories match.</p>}
              </>
            );
          })()}
          <h2>Components matching “{q}”</h2>
          {(() => {
            const found = lib.discovery.find(q, { limit: 20 });
            return (
              <>
                {found.query.corrections.length > 0 && (
                  <p className="muted small">Read as: {found.query.corrections.map((c) => `${c.from} → ${c.to}`).join(", ")}</p>
                )}
                <MatchList items={found.results} empty="Nothing in the library does this." />
              </>
            );
          })()}
          <p style={{ marginTop: 24 }}><Link href="/">Clear search</Link></p>
        </>
      ) : categories.length === 0 ? (
        <Empty title="No categories yet.">
          <p><Link href="/categories">Create your first category</Link>, then create or add components in it.</p>
        </Empty>
      ) : (
        <ShowMore items={categories.map((c) => <CategoryCard key={c.id} c={c} />)} />
      )}
    </>
  );
}
