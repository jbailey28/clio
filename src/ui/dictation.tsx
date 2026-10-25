"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, I, Mic, MicOff } from "./icons";

/**
 * Dictation for any text box: <Dictation target="prompt" /> next to a
 * <textarea id="prompt">. Words appear in the box as they're spoken, after
 * what's already there; the person can edit it all before submitting.
 *
 * Uses the browser's own speech recognition (Web Speech API). The library
 * never records or stores audio. Where the speech is turned into text depends
 * on the browser: Chrome uses Google's speech service unless its on-device
 * model is installed, in which case it stays on this Mac. The control says
 * which, and only says "on this Mac" when Chrome confirms it.
 */

type State = "unsupported" | "ready" | "requesting" | "listening" | "transcribing" | "finished" | "error";
type Where = "device" | "cloud" | "unknown";

interface Recognition {
  lang: string; continuous: boolean; interimResults: boolean; processLocally?: boolean;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: any) => void) | null; onerror: ((e: any) => void) | null; onend: (() => void) | null; onstart: (() => void) | null;
}
type RecognitionClass = (new () => Recognition) & {
  available?: (o: { langs: string[]; processLocally: boolean }) => Promise<string>;
  install?: (o: { langs: string[]; processLocally: boolean }) => Promise<boolean>;
};

const recognitionClass = (): RecognitionClass | null =>
  typeof window === "undefined" ? null : ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null);

const lang = () => (typeof navigator !== "undefined" && navigator.language) || "en-US";

/** Plain-English reasons for every failure the browser can report. */
const REASONS: Record<string, string> = {
  "not-allowed": "Microphone access was blocked. To allow it, click the icon at the left of the address bar, choose Allow for the microphone, then press Dictate again. You can keep typing either way.",
  "permission-denied": "Microphone access was blocked. To allow it, click the icon at the left of the address bar, choose Allow for the microphone, then press Dictate again. You can keep typing either way.",
  "service-not-allowed": "The browser's speech service isn't allowed here. You can keep typing, or use your Mac's own dictation (press the Fn key twice).",
  "no-microphone": "No microphone was found. Connect one, or check System Settings → Sound → Input. You can keep typing either way.",
  "audio-capture": "The microphone couldn't be used. Check it isn't in use by another app, then try again.",
  "no-speech": "No speech was heard. Press Dictate again and speak after the microphone starts pulsing.",
  network: "The speech service couldn't be reached, so nothing was transcribed. Check your internet connection and try again.",
  "language-not-supported": "Speech recognition doesn't support this browser's language. You can keep typing.",
  "on-device-unavailable": "On-device speech isn't ready yet, so nothing was transcribed. Try again in a moment.",
};
const reason = (code: string) => REASONS[code] ?? `Dictation stopped (${code}). Press Dictate to try again.`;

/** The box's text with spoken words after it: a space between, and a capital only where a sentence starts. */
function withSpeech(before: string, spoken: string): string {
  const piece = spoken.replace(/\s+/g, " ").trim();
  if (!piece) return before;
  const sep = before && !/\s$/.test(before) ? " " : "";
  const startsSentence = !before.trim() || /[.!?]\s*$|\n\s*$/.test(before); // an empty box, or after . ! ? or a new line
  return before + sep + (startsSentence ? piece.charAt(0).toUpperCase() + piece.slice(1) : piece);
}

/** Sets a text box's value and tells React it changed. */
function setValue(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
  setter ? setter.call(el, value) : (el.value = value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function Dictation({ target, label = "Dictate" }: { target: string; label?: string }) {
  const [state, setState] = useState<State>("ready");
  const [where, setWhere] = useState<Where>("unknown");
  const [localOffer, setLocalOffer] = useState<"none" | "offer" | "downloading">("none");
  const [message, setMessage] = useState("");
  const rec = useRef<Recognition | null>(null);
  const failed = useRef<string | null>(null);
  const words = useRef(0);

  // What this browser can do, checked once in the browser.
  useEffect(() => {
    const R = recognitionClass();
    if (!R || !navigator.mediaDevices?.getUserMedia) { setState("unsupported"); return; }
    if (typeof R.available === "function") {
      R.available({ langs: [lang()], processLocally: true })
        .then((a) => { setWhere(a === "available" ? "device" : "cloud"); setLocalOffer(a === "downloadable" ? "offer" : a === "downloading" ? "downloading" : "none"); })
        .catch(() => setWhere("cloud"));
    } else setWhere("cloud");
    return () => rec.current?.abort();
  }, []);

  const start = useCallback(async () => {
    const R = recognitionClass();
    const box = document.getElementById(target) as HTMLTextAreaElement | null;
    if (!R || !box) return;
    failed.current = null;
    words.current = 0;
    setMessage("");
    setState("requesting");
    // Ask for the microphone first, so a refusal or a missing microphone gets a clear message.
    // The stream is closed straight away: nothing is recorded or kept.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch (err) {
      const name = (err as DOMException)?.name;
      setMessage(reason(name === "NotAllowedError" || name === "SecurityError" ? "not-allowed" : name === "NotFoundError" || name === "OverconstrainedError" ? "no-microphone" : "audio-capture"));
      setState("error");
      return;
    }
    const r = new R();
    r.lang = lang();
    r.continuous = true;
    r.interimResults = true;
    if (where === "device" && "processLocally" in r) r.processLocally = true;
    r.onstart = () => setState("listening");
    // Words go straight into the box as they're heard. The browser's first guess for a phrase is
    // shown and then replaced by its final version, so the box is rewritten from the text it had
    // before dictation (base) plus everything heard since. If the person types meanwhile, what they
    // typed becomes the new base and only later speech is added after it.
    let base = box.value;
    let written = box.value;
    let from = 0;
    r.onresult = (e: any) => {
      if (box.value !== written) { base = box.value; from = e.resultIndex; }
      let heard = "";
      let finals = 0;
      for (let i = from; i < e.results.length; i++) {
        heard += e.results[i][0].transcript + " ";
        if (e.results[i].isFinal) finals += e.results[i][0].transcript.trim().split(/\s+/).filter(Boolean).length;
      }
      written = withSpeech(base, heard);
      setValue(box, written);
      words.current = Math.max(words.current, finals);
    };
    r.onerror = (e: any) => { if (e.error !== "aborted") failed.current = e.error; };
    r.onend = () => {
      rec.current = null;
      if (failed.current && !(failed.current === "no-speech" && words.current > 0)) { setMessage(reason(failed.current)); setState("error"); }
      else if (words.current === 0) { setMessage(reason("no-speech")); setState("error"); }
      else setState("finished");
    };
    rec.current = r;
    try { r.start(); } catch (err) { setMessage(`Dictation couldn't start: ${(err as Error).message}`); setState("error"); rec.current = null; }
  }, [target, where]);

  const stop = () => { if (!rec.current) return; setState("transcribing"); rec.current.stop(); };

  const keepLocal = async () => {
    const R = recognitionClass();
    if (!R?.install) return;
    setLocalOffer("downloading");
    try {
      const ok = await R.install({ langs: [lang()], processLocally: true });
      if (ok) { setWhere("device"); setLocalOffer("none"); } else setLocalOffer("offer");
    } catch { setLocalOffer("offer"); }
  };

  if (state === "unsupported")
    return (
      <div className="dictation" role="note">
        <button type="button" className="secondary" disabled aria-describedby={`${target}-dictation-why`}><I icon={MicOff} size={16} /> {label}</button>
        <span id={`${target}-dictation-why`} className="hint">This browser can't turn speech into text. Chrome and Safari can, or use your Mac's own dictation (press the Fn key twice) in any text box.</span>
      </div>
    );

  const busy = state === "requesting" || state === "listening" || state === "transcribing";
  return (
    <div className="dictation">
      {state === "listening" ? (
        <button type="button" className="secondary listening" onClick={stop} aria-pressed="true"><span className="mic-pulse" aria-hidden="true"><I icon={Mic} size={16} /></span> Stop</button>
      ) : (
        <button type="button" className="secondary" onClick={start} disabled={busy} aria-pressed="false">
          <I icon={Mic} size={16} /> {label}
        </button>
      )}
      <span className={`hint dictation-status ${state}`} role="status" aria-live="polite">
        {state === "ready" && <>Ready to dictate. {where === "device" ? "Speech is turned into text on this Mac." : "Chrome sends your speech to Google's speech service to turn it into text; no audio is kept here."}</>}
        {state === "requesting" && "Requesting microphone permission…"}
        {state === "listening" && "Listening…"}
        {state === "transcribing" && "Transcribing…"}
        {state === "error" && <><I icon={CircleAlert} size={14} /> {message}</>}
      </span>
      {state === "ready" && localOffer === "offer" && (
        <button type="button" className="link small" onClick={keepLocal}>Keep speech on this Mac (one-time download by Chrome)</button>
      )}
      {localOffer === "downloading" && <span className="hint">Chrome is downloading on-device speech…</span>}
    </div>
  );
}
