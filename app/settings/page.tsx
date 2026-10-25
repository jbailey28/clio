import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ReactNode } from "react";
import { getLib } from "@/src/web/lib";
import { ActionForm, CopyButton } from "@/src/ui/client";
import { Flash, PageHead, plural, type SP } from "@/src/ui/server";
import { ChevronRight, Database, FlaskConical, FolderOpen, I, Layers, Shield, Sparkles, Terminal, TriangleAlert } from "@/src/ui/icons";
import type { LucideIcon } from "lucide-react";

export const dynamic = "force-dynamic";

const MCP_COMMAND = "claude mcp add --scope user component-library -- ~/component-library/bin/component-library-mcp";

export default async function SettingsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const lib = getLib();
  const s = lib.settings.get();
  const ai = lib.creation.provider();
  const root = lib.projectCreation.root();
  const appVersion = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")).version as string;
  const schema = (lib.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v;
  const counts = {
    components: lib.components.search("", { limit: 10000 }).length,
    projects: lib.projects.list().length,
    categories: lib.categories.list().length,
  };
  // Each row saves on its own; the other setting is passed through unchanged.
  const keepRoots = <input type="hidden" name="allowedRoots" value={s.allowedRoots.join("\n")} />;
  const keepTimeout = <input type="hidden" name="testTimeoutSeconds" value={s.testTimeoutSeconds} />;

  return (
    <>
      <PageHead title="Settings" subtitle="Where the library keeps its data, and the limits it works within." />
      <Flash sp={sp} />

      <Row icon={Database} title="Data Storage" desc="Your library database and the folder that holds copied components and releases."
        value={`${plural(counts.components, "component")} · ${plural(counts.projects, "project")}`}>
        <dl className="facts" style={{ gridTemplateColumns: "auto 1fr auto", alignItems: "center" }}>
          <dt>Database</dt><dd><code>{lib.dbPath}</code></dd><dd><CopyButton text={lib.dbPath} /></dd>
          <dt>Shared code folder</dt><dd><code>{lib.paths.libraryCodeDir()}</code></dd><dd><CopyButton text={lib.paths.libraryCodeDir()} /></dd>
          <dt>Releases</dt><dd><code>{lib.releases.dir()}</code></dd><dd><CopyButton text={lib.releases.dir()} /></dd>
        </dl>
      </Row>

      <Row icon={Shield} title="Allowed Folders" desc="Source paths, test folders and project folders must be inside one of these."
        value={plural(s.allowedRoots.length, "folder")} open={!!sp.error}>
        <ActionForm op="settings.update" submit="Save allowed folders">
          <label>One folder per line<textarea name="allowedRoots" defaultValue={s.allowedRoots.join("\n")} /></label>
          {keepTimeout}
        </ActionForm>
      </Row>

      <Row icon={FolderOpen} title="Projects Location" desc="Where Create project makes new project folders." value={root.path.replace(os.homedir(), "~")}>
        {root.iCloud && <p className="notes" style={{ marginTop: 0 }}><I icon={TriangleAlert} size={14} /> {root.iCloud}</p>}
        {!root.allowed && <p className="bad-text" style={{ marginTop: 0 }}>This is outside your allowed folders, so projects can't be created there.</p>}
        <ActionForm op="settings.update" submit="Save projects location">
          <label>Folder (created when the first project is made; must be inside an allowed folder)<input name="projectsRoot" defaultValue={root.path} required /></label>
          {keepRoots}
          {keepTimeout}
        </ActionForm>
      </Row>

      <Row icon={FlaskConical} title="Tests" desc="How long a component's test run may take before it is stopped." value={`${s.testTimeoutSeconds} seconds`}>
        <ActionForm op="settings.update" submit="Save time limit">
          <label>Time limit in seconds (1 to 3600)<input name="testTimeoutSeconds" type="number" min={1} max={3600} defaultValue={s.testTimeoutSeconds} /></label>
          {keepRoots}
        </ActionForm>
      </Row>

      <Row icon={Sparkles} title="Creating Components" desc="The AI that turns a description into a component." value={ai.available ? ai.name : "Not available"}>
        <dl className="facts">
          <dt>Provider</dt><dd>{ai.name}</dd>
          <dt>Program</dt><dd><code>{ai.detail}</code></dd>
          <dt>What it can do</dt><dd>Answer only. No tools, no files, no commands, none of your Claude settings.</dd>
          <dt>Drafts</dt><dd><code>{lib.creation.stagingRoot()}</code></dd>
          <dt>Tests</dt><dd>Run in a macOS sandbox: no network, no access to your files.</dd>
        </dl>
      </Row>

      <Row icon={Terminal} title="Claude Code" id="claude-code" open={sp.open === "claude-code"} desc="The MCP server that lets Claude Code search, capture and release components.">
        <p className="hint" style={{ marginTop: 0 }}>It's set up once, for every project. To set it up again on this Mac, run:</p>
        <pre>{MCP_COMMAND}</pre>
        <CopyButton text={MCP_COMMAND} label="Copy command" />
        <p className="hint">Every change it makes asks you to approve it first. See Help for the full workflow.</p>
      </Row>

      <Row icon={Layers} title="About" desc="This copy of the Component Library." value={`Version ${appVersion}`}>
        <dl className="facts">
          <dt>App version</dt><dd>{appVersion}</dd>
          <dt>Database schema</dt><dd>version {schema}</dd>
          <dt>Categories</dt><dd>{counts.categories}</dd>
          <dt>Components</dt><dd>{counts.components}</dd>
          <dt>Projects</dt><dd>{counts.projects}</dd>
        </dl>
      </Row>
    </>
  );
}

function Row({ icon, title, desc, value, open, id, children }: { icon: LucideIcon; title: string; desc: string; value?: string; open?: boolean; id?: string; children: ReactNode }) {
  return (
    <details className="setting" open={open} id={id}>
      <summary>
        <span className="tile sm"><I icon={icon} size={18} /></span>
        <span className="body"><strong>{title}</strong><span className="desc">{desc}</span></span>
        {value && <span className="value">{value}</span>}
        <I icon={ChevronRight} className="chev" />
      </summary>
      <div className="content">{children}</div>
    </details>
  );
}
