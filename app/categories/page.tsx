import Link from "next/link";
import { getLib } from "@/src/web/lib";
import { ActionForm, SearchField, SortSelect } from "@/src/ui/client";
import { CategoryCard, Empty, Flash, PageHead, type SP } from "@/src/ui/server";
import { I, Plus } from "@/src/ui/icons";
import type { CategorySort } from "@/src/core";

export const dynamic = "force-dynamic";

const SORTS: { value: CategorySort; label: string }[] = [
  { value: "used", label: "Last used" },
  { value: "added", label: "Date added" },
  { value: "name", label: "A–Z" },
];

export default async function Categories({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const sort = (SORTS.some((s) => s.value === sp.sort) ? sp.sort : "used") as CategorySort;
  const cats = getLib().categories.list(q, sort);
  const creating = sp.new === "1";
  return (
    <>
      <PageHead title="Categories" subtitle="Browse and filter components by category."
        actions={!creating && <Link href="/categories?new=1#new-category" className="button"><I icon={Plus} size={18} /> New category</Link>} />
      <Flash sp={sp} />
      {creating && (
        <section id="new-category" className="card anchor" style={{ marginBottom: 24 }} aria-labelledby="new-category-title">
          <h2 id="new-category-title" style={{ marginTop: 0 }}>New category</h2>
          <ActionForm op="category.create" submit="Create category" returnTo="/categories?new=1">
            <label>Name<input name="name" required autoFocus /></label>
            <label>Description<input name="description" /></label>
          </ActionForm>
          <Link href="/categories">Cancel</Link>
        </section>
      )}
      <form action="/categories" method="get" role="search" className="toolbar">
        <div className="grow"><SearchField defaultValue={q} label="Search categories" placeholder="Search categories..." shortcut /></div>
        <SortSelect value={sort} options={SORTS} />
      </form>
      {cats.length ? (
        <div className="grid">{cats.map((c) => <CategoryCard key={c.id} c={c} tall />)}</div>
      ) : (
        <Empty title={q ? `No categories match “${q}”.` : "No categories yet."}>
          {!q && <p><Link href="/categories?new=1#new-category">Create the first one</Link>.</p>}
        </Empty>
      )}
    </>
  );
}
