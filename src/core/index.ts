/**
 * The service layer. The web UI and the MCP server both call `createLibrary`
 * and nothing else; all rules (validation, path checks, delete guards) live
 * behind it. Every method is a plain function over plain data.
 */
import { defaultDbPath, openDatabase, type DB } from "./db";
import * as categories from "./categories";
import * as components from "./components";
import * as projects from "./projects";
import * as testing from "./testing";
import * as settings from "./settings";
import { checkPath } from "./paths";
import * as discovery from "./discovery";
import * as packaging from "./packaging";
import * as releases from "./releases";
import * as capture from "./capture";
import * as creation from "./creation";
import * as generator from "./generator";
import * as projectCreation from "./projectCreation";
import * as projectFolders from "./projectFolders";
import * as integration from "./integration";
import * as inspection from "./inspect";
import * as removal from "./removal";
import * as claudeCode from "./claudeCode";
import { libraryCodeDir } from "./db";

export function createLibrary(db: DB, dbPath = "") {
  return {
    dbPath,
    db,
    categories: {
      list: (query?: string, sort?: categories.CategorySort) => categories.listCategories(db, query, sort),
      get: (ref: string) => categories.getCategory(db, ref),
      create: (input: categories.CategoryInput) => categories.createCategory(db, input),
      update: (ref: string, patch: Partial<categories.CategoryInput>) => categories.updateCategory(db, ref, patch),
      delete: (ref: string) => categories.deleteCategory(db, ref),
    },
    components: {
      search: (query?: string, opts?: { category?: string; limit?: number }) => components.searchComponents(db, query, opts),
      get: (ref: string) => components.getComponent(db, ref),
      create: (input: components.ComponentInput) => components.createComponent(db, input),
      update: (ref: string, patch: Partial<components.ComponentInput>) => components.updateComponent(db, ref, patch),
      delete: (ref: string, confirm: string) => components.deleteComponent(db, ref, confirm),
      recent: (limit?: number) => components.recentComponents(db, limit),
      addCapability: (ref: string, cap: Parameters<typeof components.addCapability>[2]) => components.addCapability(db, ref, cap),
      findFunctionality: (description: string, limit?: number) => discovery.findFunctionality(db, description, limit),
      findDuplicates: (input: Parameters<typeof discovery.findDuplicates>[1]) => discovery.findDuplicates(db, input),
      createPackaged: (input: components.ComponentInput, origin?: packaging.OriginInput) => packaging.registerPackagedComponent(db, input, origin),
      markViewed: (ref: string) => components.recordActivity(db, components.getComponent(db, ref).id, "viewed"),
    },
    discovery: {
      /** Ranked, explained matches for a plain-language request. */
      find: (description: string, opts?: { limit?: number; category?: string }) => discovery.discover(db, description, opts),
      /** What the browser's search box shows. */
      browse: (query: string) => discovery.discover(db, query, { limit: 20 }).results,
      /** Version, release, project use and where to read more, for one match. */
      context: (match: discovery.FunctionalityMatch, project?: string) => discovery.contextFor(db, match, project),
    },
    projects: {
      list: (sort?: projects.ProjectSort) => projects.listProjects(db, sort),
      get: (ref: string) => projects.getProject(db, ref),
      register: (input: projects.ProjectInput) => projects.registerProject(db, input),
      update: (ref: string, patch: Partial<projects.ProjectInput>) => projects.updateProject(db, ref, patch),
      unregister: (ref: string) => projects.unregisterProject(db, ref),
      link: (projectRef: string, componentRef: string, note?: string, version?: string) =>
        projects.linkComponent(db, projectRef, componentRef, note, version),
      setVersion: (projectRef: string, componentRef: string, version: string) => projects.setLinkVersion(db, projectRef, componentRef, version),
      unlink: (projectRef: string, componentRef: string) => projects.unlinkComponent(db, projectRef, componentRef),
    },
    tests: {
      run: (componentRef: string) => testing.runComponentTests(db, componentRef),
      list: (componentRef: string, limit?: number) => testing.listTestRuns(db, componentRef, limit),
      resolveCwd: (componentRef: string) => testing.resolveTestCwd(db, componentRef),
    },
    releases: {
      list: (componentRef: string) => releases.listReleases(db, componentRef),
      get: (componentRef: string, version: string) => releases.getRelease(db, componentRef, version),
      record: (componentRef: string, input: Parameters<typeof releases.recordRelease>[2]) => releases.recordRelease(db, componentRef, input),
      verify: (componentRef: string, version: string) => releases.verifyRelease(db, componentRef, version),
      changesBetween: (componentRef: string, from: string, to?: string) => releases.changesBetween(db, componentRef, from, to),
      snapshot: (input: Parameters<typeof releases.snapshotRelease>[1]) => releases.snapshotRelease(db, input),
      readiness: (componentRef: string) => releases.releaseReadiness(db, componentRef),
      create: (componentRef: string, input: Parameters<typeof releases.createRelease>[2]) => releases.createRelease(db, componentRef, input),
      dir: releases.releasesDir,
    },
    capture: {
      /** Read-only: the facts for a capture proposal. Changes nothing. */
      propose: (req: capture.CaptureRequest) => capture.proposeCapture(db, req),
    },
    /** Creating a component from a description. Each step is one explicit action. */
    creation: {
      provider: generator.provider,
      stagingRoot: creation.stagingRoot,
      list: creation.listDrafts,
      get: creation.getDraft,
      stage: creation.stageOf,
      active: creation.activeStep,
      files: creation.readBuild,
      similar: (d: creation.Draft) => creation.similarTo(db, d),
      readyToGenerate: (d: creation.Draft) => creation.readyToGenerate(db, d),
      start: (prompt: string) => creation.startDraft(db, prompt),
      retryProposal: (id: string) => creation.retryProposal(db, id),
      answer: (id: string, answers: string[]) => creation.answerQuestions(db, id, answers),
      edit: (id: string, patch: Parameters<typeof creation.editChoice>[2]) => creation.editChoice(db, id, patch),
      generate: (id: string, feedback?: string) => creation.generate(db, id, feedback),
      runTests: (id: string) => creation.runDraftTests(db, id),
      register: (id: string) => creation.registerAndRelease(db, id),
      discard: creation.discardDraft,
    },
    /** "Add existing project": browse and read folders. Never writes. */
    folders: {
      list: (at?: string) => projectFolders.listFolders(db, at),
      inspect: (at: string) => projectFolders.inspectFolder(db, at),
    },
    /** "Create project": a new folder with starter files, after approval. */
    claudeCode: {
      check: (ref: string) => claudeCode.checkOpen(db, ref),
      open: (ref: string) => claudeCode.openInClaudeCode(db, ref),
    },
    removal: {
      projectFolder: (ref: string) => removal.projectFolderCheck(db, ref),
      removeProject: (ref: string, opts: { confirm: string; trashFolder?: boolean }) => removal.removeProject(db, ref, opts),
      componentFiles: (ref: string) => removal.componentFiles(db, ref),
      removeComponent: (ref: string, opts: { confirm: string; trashFiles?: boolean }) => removal.removeComponent(db, ref, opts),
      projectCopy: (project: string, component: string) => removal.projectCopy(db, project, component),
      removeFromProject: (project: string, component: string, opts?: { trashCopy?: boolean; confirm?: string }) => removal.removeFromProject(db, project, component, opts),
    },
    projectCreation: {
      root: () => projectCreation.projectsRoot(db),
      list: projectCreation.listProjectDrafts,
      get: projectCreation.getProjectDraft,
      owns: projectCreation.ownsProjectDraft,
      freshness: projectCreation.freshness,
      decisions: projectCreation.decisions,
      ready: (d: projectCreation.ProjectDraft) => projectCreation.readyToCreate(db, d),
      readyToBuild: (d: projectCreation.ProjectDraft) => projectCreation.readyToBuild(db, d),
      included: projectCreation.includedComponents,
      connections: projectCreation.connections,
      files: projectCreation.readProjectFiles,
      testList: projectCreation.testList,
      start: (prompt: string) => projectCreation.startProjectDraft(db, prompt),
      replan: (id: string, prompt?: string) => projectCreation.planFromDescription(id, prompt),
      savePlan: projectCreation.savePlan,
      refine: (id: string, instruction: string) => projectCreation.refinePlan(id, instruction),
      undo: projectCreation.undoRefinement,
      analyze: (id: string) => projectCreation.analyzeComponents(db, id),
      choose: projectCreation.saveChoices,
      folder: projectCreation.setFolder,
      build: (id: string, feedback?: string) => projectCreation.buildProject(db, id, feedback),
      test: (id: string, again?: boolean) => projectCreation.testProject(db, id, again),
      create: (id: string) => projectCreation.createProject(db, id),
      discard: projectCreation.discardProjectDraft,
    },
    /** Putting a component's release into a project (Added), and verifying the project uses it (Connected). */
    integration: {
      preview: (project: string, component: string, version?: string) => integration.previewAdd(db, project, component, version),
      add: (project: string, component: string, version?: string) => integration.addComponentToProject(db, project, component, version),
      check: (project: string, component: string) => integration.checkConnection(db, project, component),
      inspect: (component: string, version?: string) => inspection.inspectRelease(db, component, version),
    },
    settings: {
      get: () => settings.getSettings(db),
      update: (patch: Partial<settings.Settings>) => settings.updateSettings(db, patch),
    },
    paths: {
      check: (input: string, expect?: "file" | "directory" | "any") => checkPath(db, input, expect),
      libraryCodeDir,
    },
  };
}

export type Library = ReturnType<typeof createLibrary>;

export function openLibrary(dbPath = defaultDbPath()): Library {
  return createLibrary(openDatabase(dbPath), dbPath);
}

export { LibraryError } from "./errors";
export type * from "./components";
export type * from "./projects";
export type * from "./categories";
export type * from "./testing";
export type * from "./settings";
export type * from "./discovery";
export type * from "./packaging";
export type * from "./releases";
export type * from "./capture";
export type * from "./creation";
export type * from "./projectCreation";
export type * from "./projectFolders";
export type * from "./integration";
export type * from "./inspect";
