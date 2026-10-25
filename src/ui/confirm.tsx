"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { ActionForm, useLocked } from "./client";
import { I, TriangleAlert } from "./icons";

/**
 * Every delete, remove and discard goes through this: the button opens a box
 * that says what will happen, and nothing happens until it's approved there
 * with the red button. Big or file-moving choices also need "delete" typed
 * (the server checks the word too). Cancel, Esc or a click outside closes it.
 */

export type Choice = { value: string; label: string; detail?: ReactNode; disabledWhy?: string; needsTyping?: boolean };

export function ConfirmAction({
  op, fields, trigger, triggerClass = "danger", title, children, confirmLabel, pendingLabel = "Working…",
  typeToConfirm = false, choiceName, choices, blockedWhy, returnTo, lock,
}: {
  op: string;
  /** Hidden fields sent with the action. */
  fields: Record<string, string>;
  trigger: string;
  triggerClass?: string;
  title: string;
  /** What will happen, in a line or two. */
  children?: ReactNode;
  confirmLabel: string;
  pendingLabel?: string;
  /** Always ask for "delete" to be typed. */
  typeToConfirm?: boolean;
  /** A choice of what else happens (for example: library only, or the folder too). The first is the default. */
  choiceName?: string;
  choices?: Choice[];
  /** Why it can't be done right now; the red button stays off. */
  blockedWhy?: string;
  returnTo?: string;
  lock?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const locked = useLocked(lock); // while another step of the same task runs, this waits too
  const id = useId();
  const [typed, setTyped] = useState("");
  const [choice, setChoice] = useState(choices?.[0]?.value ?? "");
  const picked = choices?.find((c) => c.value === choice);
  const needsTyping = typeToConfirm || !!picked?.needsTyping;
  const ready = !blockedWhy && (!needsTyping || typed.trim().toLowerCase() === "delete");

  const open = () => { setTyped(""); setChoice(choices?.[0]?.value ?? ""); dialog.current?.showModal(); };
  const close = () => dialog.current?.close();

  return (
    <>
      <button type="button" className={triggerClass} onClick={open} disabled={locked}
        title={locked ? "Wait for the step that's running to finish" : undefined}>{trigger}</button>
      <dialog ref={dialog} className="confirm-dialog" aria-labelledby={`${id}-title`}
        onClick={(e) => { if (e.target === dialog.current) close(); }}>
        <div className="confirm-body">
          <h2 id={`${id}-title`} className="confirm-title"><I icon={TriangleAlert} size={20} className="confirm-icon" /> {title}</h2>
          {children && <div className="confirm-text">{children}</div>}
          <ActionForm op={op} submit={confirmLabel} pendingLabel={pendingLabel} danger returnTo={returnTo} lock={lock}
            disabled={!ready} onDone={close}
            cancel={<button type="button" className="secondary" onClick={close}>Cancel</button>}>
            {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
            {choices && choices.length > 1 && (
              <fieldset className="confirm-choices">
                <legend className="sr-only">What to remove</legend>
                {choices.map((c) => (
                  <label key={c.value} className={`confirm-choice${c.disabledWhy ? " off" : ""}`}>
                    <input type="radio" name={choiceName} value={c.value} checked={choice === c.value} disabled={!!c.disabledWhy}
                      onChange={() => setChoice(c.value)} />
                    <span>
                      <span className="choice-label">{c.label}</span>
                      {c.detail && <span className="choice-detail">{c.detail}</span>}
                      {c.disabledWhy && <span className="alert-text">{c.disabledWhy}</span>}
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            {choices && choices.length === 1 && <input type="hidden" name={choiceName} value={choices[0].value} />}
            {blockedWhy && <p className="bad-text small confirm-blocked">{blockedWhy}</p>}
            {needsTyping && !blockedWhy && (
              <label className="confirm-type"><span>Type <strong>delete</strong> to confirm</span>
                <input name="confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
              </label>
            )}
          </ActionForm>
        </div>
      </dialog>
    </>
  );
}
