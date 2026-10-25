"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { CopyButton } from "./client";
import { CircleAlert, CircleCheck, I, Terminal, TriangleAlert, X } from "./icons";

type Result = {
  launched: boolean;
  message: string;
  launchProblem: string | null;
  command: string;
  cliFound: boolean;
  folder: { ok: boolean };
  auth: { loggedIn: boolean | null };
  mcp: { configured: boolean };
  platform: { canLaunch: boolean };
  error?: string;
};

/**
 * Opens the project in Claude Code: a new Terminal window in its folder, with Claude Code started there.
 * Sends only the project's id. Says exactly what happened, and gives a command to copy when it can't open.
 */
export function OpenInClaudeCode({ projectId, className }: { projectId: string; className?: string }) {
  const [pending, setPending] = useState(false);
  const [r, setR] = useState<Result | null>(null);
  const busy = useRef(false);

  async function open() {
    if (busy.current) return; // a second click while it's opening does nothing
    busy.current = true;
    setPending(true);
    try {
      const body = new FormData();
      body.set("project", projectId);
      const res = await fetch("/api/claude-code/open", { method: "POST", body });
      const data = await res.json().catch(() => ({ error: `The server answered ${res.status} without details.` }));
      setR(data);
    } catch (err) {
      setR({ error: `Could not reach the app server: ${(err as Error).message}` } as Result);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  const tone = !r ? "" : r.error || !r.folder?.ok || !r.cliFound ? "bad" : r.launched ? "ok" : "warn";
  return (
    <div className={`open-claude${className ? ` ${className}` : ""}`}>
      <button type="button" onClick={open} disabled={pending} aria-describedby={r ? `open-claude-${projectId}` : undefined}>
        <I icon={Terminal} size={18} /> {pending ? "Opening…" : "Open in Claude Code"}
      </button>
      {r && (
        <div className={`open-claude-result ${tone}`} id={`open-claude-${projectId}`} role={tone === "ok" ? "status" : "alert"}>
          <div className="open-claude-head">
            <I icon={tone === "ok" ? CircleCheck : tone === "warn" ? TriangleAlert : CircleAlert} size={16} />
            <span>{r.error ?? r.message}</span>
            <button type="button" className="icon-button" onClick={() => setR(null)} aria-label="Close" title="Close"><I icon={X} size={14} /></button>
          </div>
          {!r.error && !r.launched && r.folder?.ok && r.cliFound && r.command && (
            <div className="open-claude-command">
              <pre>{r.command}</pre>
              <CopyButton text={r.command} label="Copy command" />
            </div>
          )}
          {!r.error && r.folder?.ok && r.cliFound && !r.mcp.configured && (
            <p className="hint">Claude Code can't search your component library yet. <Link href="/settings?open=claude-code">Set it up in Settings</Link>.</p>
          )}
        </div>
      )}
    </div>
  );
}
