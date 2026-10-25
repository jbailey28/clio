import Link from "next/link";
import { notFound as nextNotFound } from "next/navigation";
import type { ReactNode } from "react";
import type { Category, ComponentSummary, FunctionalityMatch, TestStatus } from "@/src/core";
import { ArrowRight, ChevronRight, I, Package, categoryIcon } from "./icons";

export function Flash({ sp }: { sp: { ok?: string; error?: string } }) {
  return (
    <>
      {sp.ok && <p className="flash ok" role="status">{sp.ok}</p>}
      {sp.error && <p className="flash error" role="alert">{sp.error}</p>}
    </>
  );
}

/** "Not run" is shown as its own state: no evidence is not a failure. */
export function TestBadge({ status }: { status: TestStatus | null }) {
  if (!status) return <span className="badge muted">tests not run</span>;
  return <span className={`badge ${status}`}>tests {status}</span>;
}

export function ComponentList({ items, empty }: { items: ComponentSummary[]; empty: string }) {
  if (!items.length) return <Empty title={empty} />;
  return (
    <ul className="rows">
      {items.map((c) => (
        <li key={c.id}>
          <Link href={`/components/${c.slug}`} className="row-link">
            <span className="tile sm"><I icon={Package} size={18} /></span>
            <span className="body">
              <strong>{c.name}</strong> <span className="muted small">· {c.categoryName}</span>
              {c.summary && <div className="desc">{c.summary}</div>}
            </span>
            <span className="meta">{c.version ? `v${c.version}` : ""}</span>
            <TestBadge status={c.lastTestStatus} />
            <I icon={ChevronRight} className="muted" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

const STRENGTH = { strong: ["present", "strong match"], partial: ["accent", "partial match"], related: ["", "related"] } as const;

/** Search results, strongest first, each with the capability that matched and why. */
export function MatchList({ items, empty }: { items: FunctionalityMatch[]; empty: string }) {
  if (!items.length) return <Empty title={empty} />;
  return (
    <ul className="rows">
      {items.map((m) => {
        const [cls, label] = STRENGTH[m.strength];
        return (
          <li key={m.component.id}>
            <Link href={`/components/${m.component.slug}`} className="row-link result">
              <span className="tile sm"><I icon={categoryIcon(m.component.categoryName)} size={18} /></span>
              <span className="body">
                <strong>{m.component.name}</strong> <span className="muted small">· {m.component.categoryName}</span>{" "}
                <span className={`badge ${cls}`}>{label}</span> <TestBadge status={m.component.lastTestStatus} />
                {m.capability && <div className="cap">Matching capability: {m.capability.name}</div>}
                <div className="why">{m.strength === "strong" ? m.why : `${m.fit} ${m.why}`}</div>
              </span>
              <I icon={ChevronRight} className="muted" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function PageHead({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><strong>{title}</strong>{children}</div>;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Compact card for Home: icon, name, component count. */
export function CategoryCard({ c, tall }: { c: Category; tall?: boolean }) {
  const count = <span className={tall ? "count" : "muted"}>{plural(c.componentCount, "component")}</span>;
  if (tall)
    return (
      <Link href={`/categories/${c.slug}`} className="card cat-card tall">
        <span className="top">
          <span className="tile"><I icon={categoryIcon(c.name)} size={26} /></span>
          <span className="body"><strong>{c.name}</strong><span className="desc">{c.description || "No description yet."}</span></span>
          <I icon={ChevronRight} className="go" />
        </span>
        {count}
      </Link>
    );
  return (
    <Link href={`/categories/${c.slug}`} className="card cat-card">
      <span className="tile"><I icon={categoryIcon(c.name)} size={26} /></span>
      <span className="body"><strong>{c.name}</strong>{count}</span>
      <I icon={ArrowRight} className="go" />
    </Link>
  );
}

/** "3 hours ago", "2 days ago", or the date for anything older than a month. The exact time is in the title. */
export function Ago({ iso, prefix = "" }: { iso: string | null; prefix?: string }) {
  if (!iso) return <>never</>;
  const ms = Date.now() - Date.parse(iso);
  const m = Math.round(ms / 60000), h = Math.round(ms / 3600000), d = Math.round(ms / 86400000);
  const text = m < 1 ? "just now" : m < 60 ? `${plural(m, "minute")} ago` : h < 24 ? `${plural(h, "hour")} ago` : d < 31 ? `${plural(d, "day")} ago`
    : new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return <time dateTime={iso} title={new Date(iso).toLocaleString()}>{prefix}{text}</time>;
}

export const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");

export type SP = Promise<Record<string, string | undefined>>;

/** Turns a service NOT_FOUND into the 404 page; anything else still throws. */
export function orNotFound<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if ((err as { code?: string }).code === "NOT_FOUND") nextNotFound();
    throw err;
  }
}

export const CREATE_STEPS = ["Describe", "Plan", "Components", "Build", "Test"] as const;

/** "Step N of 5" and a bar of five parts. Steps that can be visited are links; nothing is redone by visiting. */
export function StepBar({ current, hrefs }: { current: number; hrefs?: (string | null)[] }) {
  return (
    <nav className="stepbar" aria-label="Progress">
      <p className="stepbar-label">Step {current + 1} of {CREATE_STEPS.length}: <strong>{CREATE_STEPS[current]}</strong></p>
      <ol>
        {CREATE_STEPS.map((s, i) => {
          const href = hrefs?.[i];
          const cls = i < current ? "done" : i === current ? "now" : undefined;
          return (
            <li key={s} className={cls} aria-current={i === current ? "step" : undefined}>
              {href && i !== current ? <Link href={href}><span className="seg" /><span className="name">{s}</span></Link> : <span className="as-text"><span className="seg" /><span className="name">{s}</span></span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
