import Link from "next/link";
import { getLib } from "@/src/web/lib";
import { ActionForm } from "@/src/ui/client";
import { ComponentFields } from "@/src/ui/component-fields";
import { Empty, Flash, PageHead, type SP } from "@/src/ui/server";
import { ArrowLeft, I } from "@/src/ui/icons";

export const dynamic = "force-dynamic";

export default async function NewComponent({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const lib = getLib();
  const categories = lib.categories.list();
  const preset = sp.category ? categories.find((c) => c.slug === sp.category)?.id : undefined;
  return (
    <>
      <Link href={preset ? `/categories/${sp.category}` : "/categories"} className="crumb"><I icon={ArrowLeft} size={16} /> Back</Link>
      <PageHead title="Add existing component" subtitle="Bring code that already exists into the library. The files are only read, never changed." />
      <Flash sp={sp} />
      {categories.length === 0 ? (
        <Empty title="You need a category first."><p><Link href="/categories?new=1#new-category">Create one</Link>.</p></Empty>
      ) : (
        <div className="card">
          <ActionForm op="component.create" submit="Add component">
            <ComponentFields categories={categories} defaultCategory={preset} />
          </ActionForm>
        </div>
      )}
    </>
  );
}
