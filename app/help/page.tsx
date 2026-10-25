import Link from "next/link";
import type { ReactNode } from "react";
import { HelpSearch } from "@/src/ui/client";
import { PageHead } from "@/src/ui/server";
import { BookOpen, ChevronRight, Folder, FlaskConical, GitBranch, I, LayoutGrid, Package, Search, Settings, Sparkles, Terminal, Wrench } from "@/src/ui/icons";
import type { LucideIcon } from "lucide-react";

const TOPICS: { id: string; icon: LucideIcon; title: string; desc: string }[] = [
  { id: "finding", icon: Search, title: "Finding components", desc: "Search in plain words and read the results." },
  { id: "capturing", icon: Package, title: "Capturing components", desc: "Turn code from a project into a component." },
  { id: "claude-code", icon: Terminal, title: "Using it in Claude Code", desc: "The MCP tools and how approvals work." },
  { id: "testing", icon: FlaskConical, title: "Testing", desc: "Run tests and read real results." },
  { id: "versioning", icon: GitBranch, title: "Versioning", desc: "Releases, checksums and upgrades." },
  { id: "projects", icon: Folder, title: "Projects", desc: "Record which project uses what." },
  { id: "categories", icon: LayoutGrid, title: "Categories", desc: "Group components and find them faster." },
  { id: "settings", icon: Settings, title: "Settings", desc: "Allowed folders, time limits and storage." },
  { id: "troubleshooting", icon: Wrench, title: "Troubleshooting", desc: "Common problems and what to do." },
];

export default function Help() {
  return (
    <>
      <PageHead title="Help" subtitle="How the library works, and how to use it from Claude Code." />
      <HelpSearch />

      <div data-help-cards>
        <h2 style={{ marginTop: 16 }}>Getting Started</h2>
        <div className="grid">
          <Card href="#start" icon={BookOpen} title="User guide" desc="The library in five steps." />
          <Card href="#creating" icon={Sparkles} title="Create a component" desc="Describe it in plain words; review, then approve." />
          <Card href="/projects/new" icon={Folder} title="Add a project" desc="Create a new one, or connect one already on your Mac." />
        </div>
        <h2>Topics</h2>
        <div className="grid">
          {TOPICS.map((t) => <Card key={t.id} href={`#${t.id}`} icon={t.icon} title={t.title} desc={t.desc} />)}
        </div>
      </div>

      <div className="prose" style={{ marginTop: 16 }}>
        <Article id="start" title="User guide">
          <p>Four words mean the same thing everywhere in the library:</p>
          <ul>
            <li><strong>Create component</strong>: make a new component from a plain-English description.</li>
            <li><strong>Add existing component</strong>: bring code you already have into the library.</li>
            <li><strong>Create project</strong>: make a new project folder on your Mac with AI help.</li>
            <li><strong>Add existing project</strong>: connect a project folder that's already on your Mac.</li>
          </ul>
          <ol>
            <li>Create a category on <Link href="/categories">Categories</Link>, for example “Website Research”.</li>
            <li>Choose <em>Create component</em> on Home and describe what you want. Or, if the code already exists, open a category and choose <em>Add existing component</em>, or let Claude Code capture it for you (see Capturing components).</li>
            <li>List what it does under Capabilities. Search reads these, so plain descriptions help.</li>
            <li>Add a test command, then run the tests from the component's Tests tab.</li>
            <li>Add the projects that use it on <Link href="/projects">My Projects</Link> (<em>Add project</em>), and record the version each one uses.</li>
          </ol>
        </Article>

        <Article id="creating" title="Creating a component from a description">
          <p>On <Link href="/">Home</Link>, choose <em>Create component</em> and describe what you want in your own words. You don't need to know the programming language, files, inputs or tests.</p>
          <ol>
            <li><strong>Review the proposal.</strong> Claude Code suggests a name, a category, what it will do, its inputs and outputs, how it will work and what the tests will check. If something is unclear it asks first. Edit the name, description and category if you like.</li>
            <li><strong>Check the library.</strong> The library's search lists components that might already do this, and Claude judges each one: does the same job, covers part of it (and what's missing), or does a different job. If one already does it, reuse it instead.</li>
            <li><strong>Choose a category.</strong> The recommended one is preselected when it fits. Pick another, or create a new one right there with <em>New category</em>. Nothing is built without a category, and no category is created unless you press the button.</li>
            <li><strong>Approve and generate.</strong> The code is written into the draft's own staging folder and checked: files only inside the component, nothing that looks like a password or key, Python's standard library only. Nothing runs yet.</li>
            <li><strong>Approve and run tests.</strong> The tests run in a macOS sandbox: no network, no access to your files, and it can only write to a temporary folder that is deleted afterwards. If they fail, <em>Fix</em> sends the failure back for another attempt.</li>
            <li><strong>Approve: add to the library.</strong> The files are copied into the library, the same tests run again on that copy, and only if they pass is version 1.0.0 released.</li>
          </ol>
          <p><strong>Speaking instead of typing.</strong> Press <em>Dictate</em> under the description box (here and in Create project), allow the microphone when Chrome asks, and speak. Press <em>Stop</em> when you're done. Your words are added after what's already in the box, and you can edit them before continuing. The library never records or keeps audio. Chrome turns speech into text with Google's speech service, unless you choose <em>Keep speech on this Mac</em>, which downloads Chrome's on-device speech once. If dictation isn't available, your Mac's own dictation (press the Fn key twice) works in any text box.</p>
          <p>Drafts are saved as you go, so you can leave or refresh and pick up where you were from <Link href="/create">Create a component</Link>. Discarding a draft deletes only its staging folder.</p>
          <p><strong>What the AI can and can't do.</strong> It runs through Claude Code on this Mac with no tools at all: it can't read, write or run anything. It only answers with text, which the library checks before writing anything. Each proposal and generation uses your Claude plan. Components are Python using only the standard library, so nothing ever needs installing; if a request needs another package, the proposal says so and it isn't built. Your description and the names and summaries of possibly similar components are sent to Claude.</p>
          <p>Already have the code? Use <Link href="/components/new">Add existing component</Link> instead.</p>
        </Article>

        <Article id="finding" title="Finding components">
          <p>Type what you need in the search box on <Link href="/">Home</Link>, in your own words: “does this company use Intercom?” works as well as a component's name. Press <kbd>⌘ K</kbd> to jump to the search box from anywhere on the page.</p>
          <p>Every result says how well it fits:</p>
          <ul>
            <li><strong>Strong match</strong>: a capability already does what you asked.</li>
            <li><strong>Partial match</strong>: it covers part of the request. The result says what is missing.</li>
            <li><strong>Related</strong>: same subject, different job. Detecting which email tool a store uses is related to sending newsletters, but it does not send them. A related result is not a solution.</li>
          </ul>
          <p>Each result names the capability that matched and why. Small misspellings are corrected and shown as “Read as”. When nothing fits, the page says so instead of stretching an unrelated component. Search runs on this Mac; nothing is sent anywhere.</p>
        </Article>

        <Article id="capturing" title="Capturing components">
          <p>When Claude Code finishes a meaningful piece of work, it may suggest saving it to the library, once, if the code solves a problem that will come up again, has clear inputs and outputs, runs without the rest of the app, and is not already in the library. It does not suggest small helpers or code tied to one app. Say no and it drops it.</p>
          <p>If you say yes, it works in this order. Each change asks you to approve it in Claude Code first:</p>
          <ol>
            <li><strong>Check</strong> the library for something that already does it. If something does, it recommends reusing or extending that instead.</li>
            <li><strong>Propose.</strong> It shows you the name, category, what it does, why it's reusable, the files it would copy and leave out, dependencies, inputs and outputs, tests, what must be separated from the project, and the risks. Nothing has changed yet.</li>
            <li><strong>Capture.</strong> The files are copied into the library's shared code folder. Your project's files are only read, never moved or changed. If the code needs separating from its app, Claude works on a copy in <code>~/.component-library/staging/</code>. Changing the original project needs your separate approval.</li>
            <li><strong>Test</strong> the library copy.</li>
            <li><strong>Release</strong> it as version 1.0.0 (see Versioning).</li>
          </ol>
          <p>Never copied: <code>.env</code> files, keys and certificates, credentials files, databases, logs, dependencies and build output. Files that would be copied are also checked for text that looks like a password, API key or webhook URL. If one is found, nothing is copied until it is removed.</p>
          <p>The project the code came from is recorded as its origin. That is not the same as using it: the project only shows as using the component after you record a version for it.</p>
        </Article>

        <Article id="claude-code" title="Using it in Claude Code">
          <p>Claude Code reaches the library through its MCP server, which is set up once for all your projects (Settings → Claude Code has the command). It reads the same database as this app, and works whether or not this app is open.</p>
          <p>Ask in plain words: “is there something in my library that detects a store's ecommerce platform?” Claude searches, reads the component's documentation and test results, and tells you whether it fully or partly solves the problem before recommending it.</p>
          <p><strong>Approvals.</strong> Anything that changes the library, and every test run, shows an approval prompt in Claude Code. Only ticking “Approve this change” and pressing Accept goes ahead. Declining, pressing Esc, or running Claude without a screen to show the prompt means no change.</p>
          <p>Read-only tools: search_components, find_reusable_functionality, check_for_duplicates, propose_capture, get_component, get_category, list_categories, get_project, list_projects, compare_versions, verify_release.</p>
          <p>Tools that change things (each one asks): create_category, register_component, update_component, add_capability, register_project, link_component, unlink_component, run_component_tests, record_release, create_release, set_project_version, unregister_project.</p>
        </Article>

        <Article id="testing" title="Testing">
          <p>Each component can have a test command, such as <code>python3 -m pytest -q</code> or <code>npm test</code>. <em>Run tests now</em> on the component's Tests tab runs it in a shell, in the test folder or the primary source folder, and saves the exit code and everything it printed.</p>
          <p>“Tests not run” means there is no result yet. It does not mean the tests failed. A run is stopped after the time limit in Settings.</p>
          <p>A release can only be made after the latest test run passed and no file changed since.</p>
        </Article>

        <Article id="versioning" title="Versioning">
          <p>A release is a frozen, read-only copy of a component at a version number, kept in the releases folder with a checksum of every file and notes on what changed. Releases are never overwritten. The component page shows each release and whether its files still match: <strong>intact</strong>, <strong>changed</strong>, or <strong>missing</strong>.</p>
          <p>Each project records the version it uses. A new release never moves a project; the version only changes when you set it on the project's Components tab, or approve it in Claude Code. When a newer release exists, the project shows it as available. In Claude Code, ask what changed between versions before upgrading.</p>
          <p>Numbers follow the usual pattern: a change to the first number (2.0.0) may change existing behavior, so read the notes first.</p>
        </Article>

        <Article id="projects" title="Projects">
          <p>On <Link href="/projects">My Projects</Link>, <em>Add project</em> offers two ways:</p>
          <ul>
            <li><strong>Create project</strong>: describe what you want to build. Claude Code proposes a name, description, folder name, technology and starter files, and you can read every file before anything happens. Edit the name, description or folder name, then <em>Approve: create project</em>. The library makes a brand-new folder in your projects location (Settings → Projects Location, <code>~/Projects</code> by default), writes only those files, and then adds the project to the library. It never overwrites an existing folder, never installs anything, never runs a command, doesn't set up git, and doesn't create components.</li>
            <li><strong>Add existing project</strong>: choose a folder with the folder browser, or type its path. The library reads only its project file (<code>package.json</code> or <code>pyproject.toml</code>) and the top of its README to suggest a name and description, which you can edit. <em>Add project</em> records it in the library; nothing in the folder is created, changed or deleted. A folder that's already in the library is recognised and linked to instead. This works without AI.</li>
          </ul>
          <p><strong>Building with your components.</strong> When you describe a new project, the library reads the actual code of every component you have (its functions, and whether it uses the network or files) and recommends only the ones that do part of the job, with what each contributes and what's still missing. Include or leave out each one. Approved components are copied unchanged from their release into the project's <code>components/</code> folder; the project's own code imports and calls them, and its tests run in the sandbox. A component is only <strong>Connected</strong> when the project's code calls it and the passing tests called it.</p>
          <p>For an existing project, <em>Add a component from your library</em> on its Components tab copies the release into a new <code>components/</code> folder without touching anything else, and shows the code to paste. It shows as <strong>Added</strong> until <em>Check connection</em> runs the project's own tests in the sandbox and sees them call it; then it's <strong>Connected</strong>. A link made by hand only says <strong>Recorded</strong>.</p>
          <p>Why a folder browser inside the app? A web page is never told where a folder is on your Mac, so the library lists folders itself: names only, only inside your allowed folders, hidden folders left out.</p>
          <p>On a project's page: Overview has its details; Components lists what it uses and at which version, where you can add, remove or change a version; Runs shows the real test runs of those components; Settings edits or removes the project. Removing a project only forgets the record. The folder is untouched.</p>
          <p>A project that code was captured from shows those components under “Captured from this project”, separately from what it uses.</p>
        </Article>

        <Article id="categories" title="Categories">
          <p>Every component belongs to one category. Create categories on <Link href="/categories">Categories</Link> with <em>New category</em>. Open one to rename it, describe it, or delete it; only an empty category can be deleted.</p>
          <p>Sort categories by <strong>Last used</strong> (the most recent time any of its components was viewed, edited, tested, released or added to a project), <strong>Date added</strong>, or <strong>A–Z</strong>. A category's icon comes from its name: “Website Research” gets a globe, a name with “Data” gets a database, and anything else gets a folder.</p>
          <p>Home shows the first six categories. <em>Show more categories</em> reveals the rest.</p>
        </Article>

        <Article id="settings" title="Settings">
          <p><Link href="/settings">Settings</Link> shows where your data lives and the limits the library works within.</p>
          <ul>
            <li><strong>Data Storage</strong>: the database file, the shared code folder that holds copied components, and the releases folder.</li>
            <li><strong>Allowed Folders</strong>: every source path, test folder and project folder must be inside one of these. Your home folder is the default.</li>
            <li><strong>Tests</strong>: the time limit for a test run, from 1 to 3600 seconds.</li>
            <li><strong>Claude Code</strong>: the command that sets up the MCP server.</li>
          </ul>
          <p>The sidebar can be collapsed to icons with the button next to the logo. This browser remembers your choice.</p>
        </Article>

        <Article id="troubleshooting" title="Troubleshooting">
          <dl>
            <dt><strong>“outside the allowed folders”</strong></dt>
            <dd>Paths must be inside a folder listed in Settings → Allowed Folders. Add the folder there, or move the code. The folder browser in Add existing project only shows folders inside them too.</dd>
            <dt><strong>“not found on disk now” or “folder not found now”</strong></dt>
            <dd>The file or folder was moved, renamed or deleted after it was recorded. Update the path on the component's Configuration tab or the project's Settings tab.</dd>
            <dt><strong>A release shows “changed” or “missing”</strong></dt>
            <dd>Its files no longer match the checksum recorded when it was made. Do not use that copy. Make a new release instead of editing an old one.</dd>
            <dt><strong>“Not released: Its tests have never been run”</strong></dt>
            <dd>Run the tests first. If files changed after the last run, run them again.</dd>
            <dt><strong>“Nothing was copied: … look like credentials”</strong></dt>
            <dd>A file contains what looks like a password, key or webhook URL. Move the value into configuration (an environment variable), then try again.</dd>
            <dt><strong>Claude Code says it cannot show an approval prompt</strong></dt>
            <dd>Library changes need the prompt. Run Claude Code in a terminal, not with <code>claude -p</code>.</dd>
            <dt><strong>Search finds the wrong thing, or nothing</strong></dt>
            <dd>Add plain descriptions to the component's capabilities. Search reads capability names and descriptions most closely.</dd>
          </dl>
        </Article>
      </div>
    </>
  );
}

function Card({ href, icon, title, desc }: { href: string; icon: LucideIcon; title: string; desc: string }) {
  return (
    <a href={href} className="card cat-card">
      <span className="tile sm"><I icon={icon} size={18} /></span>
      <span className="body"><strong style={{ fontSize: 15 }}>{title}</strong><span className="muted small">{desc}</span></span>
      <I icon={ChevronRight} className="go" />
    </a>
  );
}

function Article({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="anchor" data-help aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{title}</h2>
      {children}
    </section>
  );
}
