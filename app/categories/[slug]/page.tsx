import Link from "next/link";
import { getLib } from "@/src/web/lib";
import { ActionForm } from "@/src/ui/client";
import { ConfirmAction } from "@/src/ui/confirm";
import { ComponentList, Flash, PageHead, orNotFound, plural, type SP } from "@/src/ui/server";
import { ArrowLeft, ChevronRight, I, Plus, Settings } from "@/src/ui/icons";

export const dynamic = "force-dynamic";

export default async function CategoryPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: SP }) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const lib = getLib();
  const cat = orNotFound(() => lib.categories.get(slug));
  const items = lib.components.search("", { category: cat.id });
  return (
    <>
      <Link href="/categories" className="crumb"><I icon={ArrowLeft} size={16} /> Categories</Link>
      <PageHead title={cat.name} subtitle={cat.description || undefined}
        actions={<Link href={`/components/new?category=${cat.slug}`} className="button"><I icon={Plus} size={18} /> Add existing component</Link>} />
      <Flash sp={sp} />
      <h2>{plural(items.length, "component")}</h2>
      <ComponentList items={items} empty="No components in this category yet." />

      <details className="setting" style={{ marginTop: 32 }} open={!!sp.error}>
        <summary>
          <span className="tile sm"><I icon={Settings} size={18} /></span>
          <span className="body"><strong>Category settings</strong><span className="desc">Rename, describe or delete this category.</span></span>
          <I icon={ChevronRight} className="chev" />
        </summary>
        <div className="content">
          <ActionForm op="category.update" submit="Save category">
            <input type="hidden" name="ref" value={cat.id} />
            <label>Name<input name="name" defaultValue={cat.name} required /></label>
            <label>Description<input name="description" defaultValue={cat.description} /></label>
          </ActionForm>
          <h3>Delete category</h3>
          <p className="hint">Only empty categories can be deleted.</p>
          <ConfirmAction op="category.delete" fields={{ ref: cat.id }} trigger="Delete category" title={`Delete “${cat.name}”?`} confirmLabel="Delete" pendingLabel="Deleting…"
            blockedWhy={cat.componentCount ? `It still has ${plural(cat.componentCount, "component")}. Move or delete them first.` : undefined}>
            <p>The category is removed. Nothing on your Mac changes.</p>
          </ConfirmAction>
        </div>
      </details>
    </>
  );
}
