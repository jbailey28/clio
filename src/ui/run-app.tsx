"use client";

import { useEffect, useRef, useState } from "react";
import { CircleAlert, I, Play, Square } from "./icons";

type Running = { port: number; url: string; startedAt: string; ready: boolean } | null;

/**
 * Run and Stop for an approved project. Sends only the project's id and
 * "start" or "stop"; what runs is decided on the server.
 */
export function RunApp({ projectId, initial, initialEnded }: { projectId: string; initial: Running; initialEnded: string | null }) {
  const [running, setRunning] = useState<Running>(initial);
  const [ended, setEnded] = useState<string | null>(initialEnded);
  const [pending, setPending] = useState<"start" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  // While it's running (or starting), check every few seconds, so the card never says "Running" for something that stopped.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      if (busy.current) return;
      try {
        const body = new FormData();
        body.set("project", projectId);
        body.set("action", "status");
        const data = await (await fetch("/api/run", { method: "POST", body })).json();
        if (!data.error) { setRunning(data.running); setEnded(data.ended); }
      } catch { /* try again next time */ }
    }, 3000);
    return () => clearInterval(t);
  }, [running, projectId]);

  async function send(action: "start" | "stop") {
    if (busy.current) return; // a second click while it's working does nothing
    busy.current = true;
    setPending(action);
    setError(null);
    try {
      const body = new FormData();
      body.set("project", projectId);
      body.set("action", action);
      const res = await fetch("/api/run", { method: "POST", body });
      const data = await res.json().catch(() => ({ error: `The server answered ${res.status} without details.` }));
      if (data.error) { setError(data.error); setRunning(null); }
      else { setRunning(data.running); setEnded(data.ended); }
    } catch (err) {
      setError(`Could not reach the app server: ${(err as Error).message}`);
    } finally {
      busy.current = false;
      setPending(null);
    }
  }

  return (
    <div className="run-app">
      <div className="run-app-row">
        {running ? (
          <>
            <button type="button" className="secondary" onClick={() => send("stop")} disabled={!!pending}>
              <I icon={Square} size={16} /> {pending === "stop" ? "Stopping…" : "Stop"}
            </button>
            {running.ready
              ? <span role="status">Running at <a href={running.url} target="_blank" rel="noopener noreferrer">{running.url.replace("http://", "")} ↗</a></span>
              : <span role="status" className="muted">Starting… (it'll be at {running.url.replace("http://", "")})</span>}
          </>
        ) : (
          <>
            <button type="button" onClick={() => send("start")} disabled={!!pending}>
              <I icon={Play} size={16} /> {pending === "start" ? "Starting…" : "Run"}
            </button>
            <span className="muted" role="status">{pending === "start" ? "Starting… this can take up to 30 seconds" : "Not running"}</span>
          </>
        )}
      </div>
      {!running && ended && !error && <p className="flash error" role="alert"><I icon={CircleAlert} size={16} /> It stopped: {ended}</p>}
      {error && <p className="flash error" role="alert"><I icon={CircleAlert} size={16} /> {error}</p>}
    </div>
  );
}
