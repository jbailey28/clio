"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CircleHelp, Clock, Copy, Folder, House, I, LayoutGrid, Search, Settings } from "./icons";
import { Logo } from "./logo";

// ---------- progress ----------

/**
 * The one progress indicator: a thin purple bar that moves (or holds still
 * when reduced motion is on) and a plain-English message. Indeterminate:
 * nothing here knows a percentage, so none is shown.
 */
export function Progress({ message }: { message: string }) {
  return (
    <div className="progress" role="status" aria-live="polite">
      <div className="progress-bar" aria-hidden="true"><span /></div>
      <p>{message}</p>
    </div>
  );
}

/**
 * Locks shared by forms that belong to one task (like the steps of a draft):
 * while one is running, the others wait. Navigation is never locked.
 */
const locks = new Map<string, number>();
const lockListeners = new Set<() => void>();
export const holdLock = (key: string, delta: 1 | -1) => {
  locks.set(key, Math.max(0, (locks.get(key) ?? 0) + delta));
  lockListeners.forEach((l) => l());
};
export function useLocked(key?: string) {
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    if (!key) return;
    const update = () => setLocked((locks.get(key) ?? 0) > 0);
    lockListeners.add(update);
    update();
    return () => { lockListeners.delete(update); };
  }, [key]);
  return locked;
}

/** Asks the server what a draft is doing. Returns its own step message, or null when nothing is running. */
export function usePolledStatus(url: string | undefined, on: boolean) {
  const [detail, setDetail] = useState<string | null>(null);
  const [active, setActive] = useState<boolean | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  useEffect(() => {
    if (!url || !on) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(url, { cache: "no-store" });
        const j = await r.json();
        if (stop) return;
        setUnreachable(!r.ok);
        setActive(!!j.active);
        setDetail(j.active?.detail ?? null);
      } catch { if (!stop) setUnreachable(true); }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => { stop = true; clearInterval(t); };
  }, [url, on]);
  return { detail, active, unreachable };
}

/**
 * A form that posts to /api/do. With JavaScript it stays on the page on error
 * (so typed input is kept) and shows the message above the fields.
 *
 * While it runs: the button is disabled at once (no second submit), and after
 * a moment the shared Progress appears with `pendingLabel`, or the server's
 * own step message when `statusUrl` reports one. `lock` disables other forms
 * of the same task meanwhile.
 */
export function ActionForm({
  op,
  children,
  submit,
  pendingLabel = "Working…",
  returnTo,
  className,
  danger,
  statusUrl,
  lock,
  secondary,
  disabled: blocked,
  cancel,
  onDone,
}: {
  op: string;
  children?: ReactNode;
  submit: string;
  pendingLabel?: string;
  returnTo?: string;
  className?: string;
  danger?: boolean;
  statusUrl?: string;
  lock?: string;
  secondary?: boolean;
  /** Keeps the button off (for example until a confirmation is typed). */
  disabled?: boolean;
  /** A Cancel button shown beside the submit button. */
  cancel?: ReactNode;
  /** Called after the action worked, before moving on. */
  onDone?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [slow, setSlow] = useState(false);
  const running = useRef(false);
  const lockedByOther = useLocked(lock);
  const { detail } = usePolledStatus(statusUrl, pending);

  useEffect(() => {
    if (!pending) { setSlow(false); return; }
    const t = setTimeout(() => setSlow(true), 300); // fast actions never flash a progress bar
    return () => clearTimeout(t);
  }, [pending]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (running.current || lockedByOther || blocked) return; // a second click or Enter does nothing; nor does a blocked form
    running.current = true;
    if (lock) holdLock(lock, 1);
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/do", { method: "POST", body: new FormData(e.currentTarget), headers: { "x-fetch": "1" } });
      const data = await res.json().catch(() => ({ ok: false, error: `The server answered ${res.status} without details.` }));
      if (data.ok) {
        onDone?.();
        router.push(data.redirect);
        router.refresh();
      } else setError(data.error);
    } catch (err) {
      setError(`Could not reach the app server: ${(err as Error).message}`);
    } finally {
      running.current = false;
      if (lock) holdLock(lock, -1);
      setPending(false);
    }
  }

  const disabled = pending || (lockedByOther && !pending) || !!blocked;
  return (
    <form action="/api/do" method="post" onSubmit={onSubmit} className={className} aria-busy={pending}>
      <input type="hidden" name="op" value={op} />
      <input type="hidden" name="returnTo" value={returnTo ?? pathname} />
      {error && <p className="flash error" role="alert"><strong>That didn't work.</strong> {error}{" "}<span className="hint">You can try again.</span></p>}
      {children}
      {cancel ? <div className="dialog-actions">{cancel}<button type="submit" disabled={disabled} className={danger ? "danger" : secondary ? "secondary" : undefined}
        title={lockedByOther && !pending ? "Wait for the step that's running to finish" : undefined}>
        {pending ? "Working…" : submit}
      </button></div> : <><button type="submit" disabled={disabled} className={danger ? "danger" : secondary ? "secondary" : undefined}
        title={lockedByOther && !pending ? "Wait for the step that's running to finish" : undefined}>
        {pending ? "Working…" : submit}
      </button></>}
      {pending && slow && <Progress message={detail ?? pendingLabel} />}
    </form>
  );
}

/**
 * Shown when a page opens while one of its steps is already running on the
 * server (after a refresh, or in another tab). It keeps asking the server and
 * reloads the page when the step ends. If the server can't be asked, it says
 * so instead of claiming the step is still running.
 */
export function LiveActivity({ statusUrl, step, detail: initial, lock }: { statusUrl: string; step: string; detail?: string; lock?: string }) {
  const router = useRouter();
  const { detail, active, unreachable } = usePolledStatus(statusUrl, true);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!lock) return;
    holdLock(lock, 1);
    return () => holdLock(lock, -1);
  }, [lock]);
  useEffect(() => {
    if (active === false && !done) { setDone(true); router.refresh(); }
  }, [active, done, router]);
  if (done) return <p className="flash ok" role="status">The {step} step finished. Showing the result…</p>;
  if (unreachable) return <p className="flash error" role="alert">Can't check on the {step} step right now. Refresh to see where it is.</p>;
  return <Progress message={detail ?? initial ?? `Working on the ${step} step…`} />;
}

const NAV = [
  { href: "/", label: "Home", icon: House },
  { href: "/categories", label: "Categories", icon: LayoutGrid },
  { href: "/recent", label: "Recently Used", icon: Clock },
  { href: "/projects", label: "My Projects", icon: Folder },
];
const BOTTOM = [
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/help", label: "Help", icon: CircleHelp },
];

/**
 * The sidebar: icons at rest, opening over the page (labels and the CLIO
 * name) while the pointer is over it or keyboard focus is inside it. The
 * labels are always there for screen readers.
 */
export function Sidebar() {
  const pathname = usePathname();
  const active = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  const link = (n: (typeof NAV)[number]) => (
    <Link key={n.href} href={n.href} className={`nav-link${active(n.href) ? " active" : ""}`} aria-current={active(n.href) ? "page" : undefined}>
      <I icon={n.icon} size={22} />
      <span className="nav-label">{n.label}</span>
    </Link>
  );
  return (
    <div className="sidebar-slot">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <Link href="/" aria-label="CLIO home"><Logo /><span className="wordmark" aria-hidden="true">CLIO</span></Link>
        </div>
        {NAV.map(link)}
        <div className="bottom">
          <div className="divider" role="separator" />
          {BOTTOM.map(link)}
        </div>
      </nav>
    </div>
  );
}

/**
 * A search box that submits on Enter (works without JavaScript). With
 * `shortcut`, ⌘K or Ctrl+K focuses it from anywhere on the page.
 */
export function SearchField({ name = "q", defaultValue, placeholder, label, shortcut, compact, hidden }: {
  name?: string; defaultValue?: string; placeholder: string; label: string; shortcut?: boolean; compact?: boolean;
  hidden?: Record<string, string>;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [mac, setMac] = useState(true);
  useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.platform));
    if (!shortcut) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); ref.current?.focus(); ref.current?.select(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcut]);
  return (
    <div className={`searchbar${compact ? " compact" : ""}`}>
      <I icon={Search} size={compact ? 18 : 22} />
      <label className="sr-only" htmlFor={`search-${name}`}>{label}</label>
      <input ref={ref} id={`search-${name}`} type="search" name={name} defaultValue={defaultValue} placeholder={placeholder} autoComplete="off" />
      {Object.entries(hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {shortcut && <span className="kbd" aria-hidden="true">{mac ? "⌘ K" : "Ctrl K"}</span>}
    </div>
  );
}

/** A select that re-runs its form when changed. Without JavaScript, the Apply button does the same. */
export function SortSelect({ name = "sort", value, options, label = "Sort by" }: {
  name?: string; value: string; options: { value: string; label: string }[]; label?: string;
}) {
  return (
    <label className="sort">
      <span>{label}</span>
      <select name={name} defaultValue={value} onChange={(e) => e.currentTarget.form?.requestSubmit()}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <noscript><button type="submit" className="secondary">Apply</button></noscript>
    </label>
  );
}

/** Shows the first `initial` items; a centered text control reveals the rest and then disappears. */
export function ShowMore({ items, initial = 6, label = "Show more categories" }: { items: ReactNode[]; initial?: number; label?: string }) {
  const [open, setOpen] = useState(false);
  const firstHidden = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) firstHidden.current?.querySelector("a")?.focus(); }, [open]);
  return (
    <>
      <div className="grid">
        {items.slice(0, initial)}
        {open && items.slice(initial).map((item, i) => (i === 0 ? <div key="first" ref={firstHidden} style={{ display: "contents" }}>{item}</div> : item))}
      </div>
      {!open && items.length > initial && (
        <button type="button" className="show-more" onClick={() => setOpen(true)}>{label}</button>
      )}
    </>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="secondary" aria-label={`${label}: ${text}`}
      onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch {} }}>
      <I icon={Copy} size={16} /> {done ? "Copied" : label}
    </button>
  );
}

/** Filters the help articles on the page by the words typed. Every article stays readable without JavaScript. */
export function HelpSearch() {
  const [q, setQ] = useState("");
  const [shown, setShown] = useState<number | null>(null);
  useEffect(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    let n = 0;
    document.querySelectorAll<HTMLElement>("[data-help]").forEach((el) => {
      const hit = words.every((w) => (el.textContent ?? "").toLowerCase().includes(w));
      el.hidden = !hit;
      if (hit) n++;
    });
    document.querySelectorAll<HTMLElement>("[data-help-cards]").forEach((el) => { el.hidden = words.length > 0; });
    setShown(words.length ? n : null);
  }, [q]);
  return (
    <>
      <div className="searchbar compact" style={{ marginBottom: 8 }}>
        <I icon={Search} size={18} />
        <label className="sr-only" htmlFor="help-search">Search help articles</label>
        <input id="help-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search help articles..." autoComplete="off" />
      </div>
      <p className="hint" aria-live="polite">{shown === null ? "\u00a0" : shown === 0 ? `No article mentions “${q}”.` : `${shown} article${shown === 1 ? "" : "s"} mention “${q}”.`}</p>
    </>
  );
}
