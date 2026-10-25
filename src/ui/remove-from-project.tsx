import { getLib } from "@/src/web/lib";
import { ConfirmAction } from "./confirm";

/** "Remove" on a component in a project. If the project holds its own copy, choose whether that copy goes to the Trash. */
export function RemoveFromProject({ project, component, returnTo }: { project: { id: string; name: string }; component: { id: string; name: string }; returnTo: string }) {
  const copy = getLib().removal.projectCopy(project.id, component.id);
  return (
    <ConfirmAction op="project.unlink" fields={{ project: project.id, component: component.id }} trigger="Remove" triggerClass="secondary"
      title={`Remove “${component.name}” from “${project.name}”?`} confirmLabel="Remove" pendingLabel="Removing…" returnTo={returnTo}
      choiceName="copy"
      choices={copy ? [
        { value: "keep", label: "Remove from the project's record only", detail: <>The project's copy stays: <code>{copy}</code></> },
        { value: "trash", label: "Move copy to the Trash", detail: <>Code in the project that uses it will stop working. <code>{copy}</code></>, needsTyping: true },
      ] : undefined}>
      <p>{copy ? "The library stops listing it as used by this project." : "The library stops listing it as used by this project. Nothing on your Mac changes."}</p>
    </ConfirmAction>
  );
}
