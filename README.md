# CLIO, Your Personal Component Library

## What CLIO does

Right now, CLIO lets you:

- **Save and organize components.** Keep reusable functionality in one place instead of searching through old projects.
- **Understand what you've built.** Each component has a description of its capabilities, checks, and test results.
- **Track where components are used.** See which projects use a component and which version they're using.
- **Connect with Claude Code.** CLIO has an MCP server that lets Claude search your library when you're working on something new.
- **Build projects using existing components.** Describe what you want to build, review a plan, and choose which components to reuse.
- **Test your work.** Check whether components are working and whether a new project is actually using them.

CLIO keeps its data locally. You don't need to store your projects or component library on a service I operate.

The features that use AI run through your own Claude Code, so what you describe and the relevant component code are sent to Claude.

## What I'm working on next

A lot of my time building with Claude is spent figuring out the design and functionality at the same time.

I'm working toward adding visual components to CLIO, so I can save things like buttons, forms, cards, and navigation, including how they behave when you interact with them.

I'd also like to be able to select several components while browsing my library and use them as the starting point for a new project.

Those features are still in development.

## Getting started

CLIO is a local application with a browser interface and an optional connection to Claude Code through MCP.

The installation instructions below explain how to set it up on your own computer.

### What you need

- A Mac. CLIO runs tests inside the sandbox built into macOS, and the "Open in Claude Code" button uses the Mac's Terminal.
- [Node.js 22](https://nodejs.org/). CLIO's database library is built for Node 22, so other versions won't load it.
- Python 3. CLIO uses it to read your components' code. Run `python3 --version` to check; if it's missing, your Mac offers to install it.
- [Claude Code](https://claude.com/claude-code), installed and signed in, for the features that use AI.

### Install and run

```
git clone https://github.com/jbailey28/clio.git
cd clio
npm install
npm run build
npm start
```

Then open http://127.0.0.1:4410 in your browser. To stop CLIO, press Ctrl+C in that window.

Your library is saved in `~/.component-library/library.db` on your computer. Set `COMPONENT_LIBRARY_HOME` to keep it somewhere else.

### Connect it to Claude Code (optional)

From inside the `clio` folder, run:

```
claude mcp add --scope user component-library -- "$PWD/bin/component-library-mcp"
```

Claude Code can then search your library while you work. Every change it wants to make to your library asks for your approval first.

## Why I'm building it

I've been trying to build one useful project a week with Claude Code, ideally getting a working version done in a day.

I don't expect CLIO to make every project possible to finish that quickly. I'm mostly interested in understanding how things work, how projects are structured, how integrations connect, and how to test what I'm building.

If I can reuse something I built last week instead of starting over, I'd like to do that.

And if this helps someone else organize what they're building, even better.

---

# How it works (for developers)

A local library of reusable code: categories, components (pointing at real source on disk), their capabilities and checks, inputs/outputs, dependencies, tests, and the projects that use them.

`npm run dev` runs the app with hot reload. Migrations run automatically on start and are safe to repeat.

## Test

```
npm test           # service-layer tests (temp database, temp folders)
npm run acceptance # builds, starts a throwaway copy on port 4411, drives every form over HTTP
npm run typecheck
```

## Layout

- `src/core/`: the service layer. All rules live here. `createLibrary(db)` / `openLibrary()` in `src/core/index.ts` is the only entry point. The MCP server should import it the same way the web app does.
- `src/web/`: browser glue. `actions.ts` maps each form `op` to one service call. `forms.ts` turns text boxes into service input.
- `app/`: Next.js pages. Every form posts to `app/api/do/route.ts`.
- `src/ui/`: shared interface pieces. `icons.tsx` is the one icon set (Lucide, one size and stroke); a category's icon comes from its name. Colors and spacing are the variables at the top of `app/globals.css`, sampled from the approved designs; every gap is a multiple of the 8px unit.
- `library/`: an optional folder to keep shared code in. Components can point anywhere inside the allowed folders.

## Safety rules (enforced in `src/core`)

- Every path goes through `checkPath`: must be absolute, must exist, symlinks resolved, must sit inside an allowed folder (Settings; default is your home folder), and never `/`.
- Nothing ever writes to, creates, or deletes files in a source folder or a project folder.
- Copies into the library and releases skip secrets and private data, and refuse files containing credential-looking text (see Capturing code).
- A category can only be deleted when it is empty. A component can only be deleted when no project uses it, and only after you type its slug.
- Tests run the real command (`/bin/sh -c`) with a timeout and store the exit code and output. With no run, the status is "not run", never "failed".

## Claude Code (MCP)

`bin/component-library-mcp` starts the MCP server over stdio (`src/mcp/main.ts` → `src/mcp/server.ts`). It opens the same database through `openLibrary()` and doesn't need the browser app. It's registered at user scope:

```
claude mcp add --scope user component-library -- "$PWD/bin/component-library-mcp"   # run inside the clio folder
```

better-sqlite3 is compiled for Node 22, so the launcher picks a Node 22 (from nvm if present, otherwise `node` on PATH). `COMPONENT_LIBRARY_NODE` overrides the choice. If you switch Node versions, run `npm rebuild better-sqlite3`.

Read-only tools: `search_components`, `find_reusable_functionality`, `check_for_duplicates`, `propose_capture`, `list_categories`, `get_category`, `get_component`, `list_projects`, `get_project`, `compare_versions`, `verify_release`.

Tools that change things: `create_category`, `register_component` (optionally `package_into_library`, `origin_project`), `update_component`, `add_capability`, `register_project`, `link_component`, `unlink_component`, `run_component_tests`, `record_release`, `create_release`, `set_project_version`, `unregister_project`.

**Approval:** every change, and every test run, sends an MCP elicitation that Claude Code shows to you, not to the model. Only ticking "Approve this change" and pressing Accept goes ahead. Decline, Esc, a client that can't show the prompt, and non-interactive `claude -p` all mean no change. Tool annotations (`readOnlyHint` / `destructiveHint`) are set too, but they are hints for the client; the elicitation check in `src/mcp/server.ts` is what enforces approval.

### Building projects from components

Create project plans from the components' **real code**: `src/core/inspect.ts` reads each release with Python's parser (never imports it): packages, public functions and signatures, imports, network/file/program use, environment variables. Libraries under 30 components are inspected whole; the AI sees that evidence and the plan shows only the components it recommends, each with what it contributes, what's missing, and problems if its named functions don't exist. The person includes or leaves out each one.

Build (approval) writes everything in staging (`src/core/projectCreation.ts`): each approved release copied byte for byte into `components/<slug>/` with its RELEASE.json (`src/core/integration.ts`), `component_paths.py` (import paths) and `tests/test_components_match_release.py` (written by the library), and the AI's project code. Checks: paths, secrets, standard-library imports, and that the project's own code imports **and calls** each component (Python's parser). Test (approval) runs the project's tests in the sandbox with a tracer (`sandboxedTraceCommand`) that records which component functions were entered from outside the component. **Connected** = code calls it + passing tests called it. Create (approval) copies the tested build into a new folder, checks it matches staging, then records the project and every link (version + `integration`) in one transaction; any failure removes the folder and records nothing.

Existing projects: **Add** copies a release into a new `components/<slug>/` only (no other file touched) → `added`; **Check connection** runs the project's own tests traced in the sandbox (and checks the copy still matches its release) → `connected` or stays `added` with the reason. Links made by hand stay `""` (Recorded). Migration 4 adds `project_components.integration`, `integration_detail`, `integration_checked_at`.

Tests: `tests/project-integration.test.ts`.

### Dictation

`src/ui/dictation.tsx`: `<Dictation target="<textarea id>" />` adds a Dictate button to any text box (used on Create component and Create project). It uses the browser's Web Speech API: the microphone permission is the browser's own, final results are appended after the existing text (editable), interim words are shown while listening, and states are Ready / Requesting microphone permission / Listening / Transcribing / Finished / Error, announced to screen readers. The library never records or stores audio (the permission check closes its stream at once). Chrome sends speech to Google's speech service unless its on-device model is installed (`SpeechRecognition.available` reports `"available"`), in which case it sets `processLocally`; "Keep speech on this Mac" asks Chrome to install it. Browsers without speech recognition get a disabled button and a reason. Tests drive it with a stand-in microphone and engine (`scripts/ui-browser.ts`).

### Adding projects (browser)

My Projects → **Add project** (`/projects/new`) offers **Create project** and **Add existing project**. Terms used everywhere in the app: Create component (from a description), Add existing component (code you have), Create project (new folder with AI help), Add existing project (a folder you have). Internal and MCP names (`register_component`, `register_project`, `project.register`) are unchanged.

- **Add existing project** (`/projects/add`, no AI): a web page is never told real folder paths, so the server lists folders itself (`src/core/projectFolders.ts`): names only, inside the allowed folders, hidden folders left out; typing a path is the fallback. Choosing one reads only `package.json` / `pyproject.toml` and the top of the README to suggest a name and description. A folder already in the library is recognised; adding it is `project.register`, which never touches the folder.
- **Create project** (`/projects/create`, `src/core/projectCreation.ts`): Claude Code (no tools) proposes a name, description, folder name, technology and starter files; every file is shown first. Approval creates a brand-new folder in Settings → Projects Location (default `~/Projects`, must be inside an allowed folder, iCloud Desktop/Documents warned about), writes only those files (paths, types, sizes and the secret scan checked), and only then adds the project. Never overwrites, installs, runs commands, sets up git or creates components; a failure removes only the folder it made. Drafts (`pdr_`) share the component draft store (`src/core/drafts.ts`) and its progress reporting.

Tests: `tests/projects-add.test.ts`; `scripts/ui-browser.ts` drives both flows.

### Creating a component from a description (browser)

Home → **Create component** (`/create`). Describe it in plain words; the rest is worked out and shown for review. Code: `src/core/creation.ts` (the steps), `src/core/generator.ts` (the AI), `src/core/sandbox.ts` (where tests run), pages in `app/create/`.

1. **Proposal.** Claude Code proposes a name, category, what it does, inputs and outputs, approach, dependencies and tests, and asks questions only if it must. The Milestone 6 search shortlists components that might already do it, and the AI judges each one (same job / part of it / different job), because word overlap alone over-matches long descriptions. The person can edit the name, description and category, or create a category on the spot.
2. **Generate** (button). Written into `<data>/staging/<draft>/build/<slug>/`, then checked: plain relative paths inside the component only, `.py .md .txt .json`, size limits, the capture secret scan and name rules, imports limited to Python's standard library (checked against the system Python), and notes for network use, running programs, deleting files, eval/exec, environment variables.
3. **Run tests** (button). `sandboxedPythonTestCommand()`: `sandbox-exec` with no network, read access only to the component's folder and a fresh temp folder, writes only to that temp folder.
4. **Add to the library and release 1.0.0** (button). Only when the latest staged run passed on exactly the current files. Uses `registerPackagedComponent`, `runComponentTests` (same sandboxed command, on the library copy) and `createRelease`. A failure there leaves it registered but unreleased, and says so.

**The AI.** `claude -p` with `--tools ""` (it can only answer), `--strict-mcp-config`, `--setting-sources ""`, `--no-session-persistence`, a budget cap, structured output, in an empty folder. It uses the Mac's Claude Code sign-in, so the library stores no API key and nothing reaches the browser. `COMPONENT_LIBRARY_MODEL` picks the model (default `sonnet`); `CLAUDE_CLI` its path. `COMPONENT_LIBRARY_GENERATOR` swaps in another command that reads `{task, prompt, schema}` on stdin and prints JSON; the tests use `tests/create/fake-generator.mjs`.

**Scope.** Python 3.9, standard library only, unittest. Nothing is ever installed: a proposal that needs a package says so and can't be generated.

**Drafts** are files (`draft.json` plus the build folder), so refreshing or leaving resumes the draft; one step runs at a time per draft, and a step left by a crash expires after 15 minutes. Discarding removes only that draft's folder. No database change.

**Categories.** Every component has exactly one category (database constraint, required on every create, checked again before generating, registering and releasing). Categories can be created on their own or from a draft, and can only be deleted when empty.

**Requests from other websites.** `/api/do` refuses a post whose browser headers say it came from another site, and any request addressed to a host other than 127.0.0.1 / localhost (DNS rebinding). Scripts on this Mac that send no browser headers still work.

Tests: `tests/create.test.ts` (every scenario, real sandbox, stand-in AI); `scripts/ui-browser.ts` drives the whole flow in Chrome.

### Capturing code from a project

How reusable code gets from a project into the library. The rules Claude follows are in the server instructions (`src/mcp/server.ts`), so they load in every Claude Code session.

1. **Recognize.** After finishing meaningful work, Claude may suggest a capture once, in a sentence or two, when the code solves a repeatable problem, has a clear interface, runs without the app's internal state, and isn't already in the library. Not for small helpers, glue code or app-specific logic.
2. **Check.** `find_reusable_functionality`: strong match → reuse it; partial → extend it; related → explain the difference; none → propose.
3. **Propose.** `propose_capture` (read-only) reports exactly which files would be copied and left out, lines that look like credentials, imports that reach outside the copied files, configuration it reads, tests, dependencies, the source project and the destination, plus signals ("Small", "Tied to its application", "No tests") and blockers. Claude shows the proposal in chat and waits.
4. **Separate.** The original project is only ever read. If the code reaches into its app, Claude prepares a separated copy in `~/.component-library/staging/<slug>/` and proposes that. Changing the original project needs its own approval.
5. **Capture.** `register_component` with `package_into_library` and `origin_project` copies the files into `library/<slug>/` and records where they came from. Approval prompt.
6. **Test.** `run_component_tests` in the library copy. Approval prompt.
7. **Release.** `create_release` freezes `library/<slug>/` as `library/releases/<slug>/<version>/` with RELEASE.json checksums, read-only, and records it. It refuses unless the latest test run passed and no file changed since. Approval prompt.

**Origin is not use.** Where a component came from is stored on the component (`origin` in `get_component`, `originOf` in `get_project`), not in project links. A project only "uses" a component at a version after `link_component`, and Claude warns before linking the origin project.

**Never copied:** dependencies and build output, `.git`, `.env*`, keys and certificates, SSH keys, credentials files (`.npmrc`, `.netrc`, …), data or config files named like secrets, tokens, passwords or webhooks, databases and logs. Files that would be copied are also scanned; a line that looks like a real credential (private keys, AWS/Anthropic/OpenAI/GitHub/Slack/Stripe/Google keys, webhook URLs, a password or key written into the code) blocks the whole copy rather than silently dropping the file. The same rules apply to releases.

Tests: `tests/capture.test.ts` (service layer) and `tests/mcp-capture.test.ts` (the whole journey over MCP: decline, approve, test, release, reuse from a second project, clean-up).

### Discovery

`find_reusable_functionality`, `search_components`, `check_for_duplicates` and the browser's search box share one search (`src/core/discovery.ts`). It is local and explainable: no model, no external service, and no index to rebuild, because it reads the library fresh on every search. It scores each capability of each component on:

- the request's own words, stemmed;
- concepts from `src/core/vocabulary.ts`, so synonyms and vendor names meet ("live chat", "helpdesk" and "Intercom" all reach support chat detection);
- the job asked for, so detecting email marketing tools is not confused with sending newsletters, or detecting review widgets with analyzing reviews;
- small misspellings (six letters or more, one edit away), corrected against the library's own words and shown to the caller.

Every result is **strong** (does what was asked), **partial** (covers part of it; `unmatched` says what's missing) or **related** (same subject, different job, never a solution), and names the capability that matched and why. When a request misses that should match, add the wording to `vocabulary.ts`.

Evaluation: `npx tsx scripts/discovery-eval.ts --cases` scores 52 realistic searches in throwaway libraries (Website Analysis alone, and with five overlapping fixtures). `npx vitest run tests/discovery.test.ts` enforces the same numbers. Browser check: `NEXT_DIST_DIR=.next-test npx next build && NEXT_DIST_DIR=.next-test npx tsx scripts/discovery-browser.ts`. `NEXT_DIST_DIR` keeps a test build out of `.next`, which a running app serves from; use it for `scripts/acceptance.ts` too while the app is running.

Tests: `tests/mcp.test.ts` runs a real MCP client against the real server process.

Interface check: `NEXT_DIST_DIR=.next-test npx next build && NEXT_DIST_DIR=.next-test npx tsx scripts/ui-browser.ts` drives a headless Chrome (clicks, typing, ⌘K, Tab) through every screen on port 4412 with a throwaway library: Show more, sidebar collapse, sorting, search, project tabs, settings, help search, labels on every field, and phone width. Add `--shots <folder>` to save screenshots. Set `CHROME` if Chrome is not in /Applications.
