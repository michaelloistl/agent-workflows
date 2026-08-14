// The PLANNER: what `init` or `sync` would change in this repo, decided as data.
//
// One planner, two policies — the same shape as the sequencer's one plan behind two
// entry points (ADR-0005). `init` is told which verbs to enable and writes what is
// missing; `sync` DETECTS which verbs the repo already enabled and updates them in
// place. Everything else — the scripts, the labels, the pin, the warnings — is common,
// so the two commands cannot drift into disagreeing about what an installed repo
// looks like.
//
// Nothing here touches the filesystem, `gh`, or the network: the entry point reads the
// repo into a `RepoState`, this decides, and the entry point applies. That split is
// what makes "what would sync do to a repo pinned at v1.2 with two overrides and a
// hand-edited caller?" a unit test rather than a scratch checkout.

import type { CallerSpec, Verb } from "./catalog.mts";
import { CALLERS, VERBS, callersFor, labelsFor, secretsFor } from "./catalog.mts";
import type { CallerOptions } from "./callers.mts";
import { renderCaller, repinCaller, usesRef } from "./callers.mts";
import type { ScriptMerge } from "./scripts.mts";
import { consumerScripts, dependencySpec, mergeScripts, refFromSpec } from "./scripts.mts";

export type Mode = "init" | "sync";

export interface PackageJson {
  readonly name?: string;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly [key: string]: unknown;
}

// The repo as read off disk and out of `gh`, before any decision is made.
export interface RepoState {
  // Parsed `package.json`, or null when the repo has none (a Rails or Go repo that
  // has never needed one).
  readonly packageJson: PackageJson | null;
  readonly hasYarnLock: boolean;
  // `.node-version`, or null. Absent is fine when the caller passes `node-version`,
  // which is why this is a warning and never an error.
  readonly nodeVersion: string | null;
  // Contents of the caller files present under `.github/workflows/`, keyed by the
  // catalog's file name. Only the files the catalog knows about.
  readonly callers: Readonly<Record<string, string>>;
  // Paths under `.sandcastle/agent-workflows/`, relative to it — the consumer's
  // entrypoint overrides.
  readonly overrides: readonly string[];
  readonly hasConfig: boolean;
  // Label names that already exist in the repo.
  readonly labels: readonly string[];
  // Secret names already set on the repo (values are never read), or null when the
  // list could not be read at all — reading secrets needs admin, and a collaborator
  // without it must not be told the secrets are missing when they may well be set.
  readonly secrets: readonly string[] | null;
}

export interface PlanInput {
  readonly mode: Mode;
  readonly state: RepoState;
  // The packaged package.json's scripts — the source the consumer's are derived from.
  readonly packagedScripts: Readonly<Record<string, string>>;
  // The version of the package doing the installing, for the report.
  readonly packagedVersion: string;
  // Explicit verb selection. On `init` this defaults to every verb; on `sync` a null
  // selection means "whatever this repo already enabled".
  readonly verbs: readonly Verb[] | null;
  readonly workflowsRepo: string;
  readonly ref: string;
  readonly enableRuby: boolean;
  readonly gitAuthorEmail: string;
  readonly publicRepo: boolean;
  // Written to `.sandcastle/agent-workflows/config.json` when set. Absent leaves the
  // file alone: every value there resolves override → file → default, so no file means
  // stock behaviour.
  readonly baseBranch: string | null;
}

export interface FileWrite {
  readonly path: string;
  readonly content: string;
  // What this write does, in the plan output.
  readonly reason: string;
  readonly existing: boolean;
}

export interface Warning {
  readonly message: string;
  // What the human should do about it. Warnings are things the installer deliberately
  // will not fix on its own, so every one of them ends in an instruction.
  readonly fix: string;
}

export interface Plan {
  readonly mode: Mode;
  readonly verbs: readonly Verb[];
  readonly writes: readonly FileWrite[];
  // The merged `package.json` to write, plus what changed. Null when nothing changed.
  readonly packageJson: {
    readonly content: PackageJson;
    readonly scripts: ScriptMerge;
    readonly dependency: { readonly from: string | null; readonly to: string };
    readonly created: boolean;
  } | null;
  // Trigger labels that do not exist yet.
  readonly labels: readonly string[];
  // Whether the dependency changed, so the entry point knows to reinstall.
  readonly install: boolean;
  readonly warnings: readonly Warning[];
  readonly notes: readonly string[];
  // A fatal reason the plan cannot proceed, or null. `sync` on an uninstalled repo is
  // the main one — it is a different command's job, and guessing would write a caller
  // set the repo never asked for.
  readonly blocked: string | null;
}

const PACKAGE_NAME = "agent-workflows";
const CONFIG_PATH = ".sandcastle/agent-workflows/config.json";
const WORKFLOW_DIR = ".github/workflows";

// Which verbs a repo has already enabled: the union of the verbs its present callers
// imply and the verbs its `sandcastle:*` scripts imply.
//
// Unioned rather than intersected because the two get out of step in both directions
// and each direction is worth acting on: a caller with no scripts is a repo that was
// set up by hand, and scripts with no caller is a verb someone disabled by deleting a
// file. `sync` updates both and warns about the mismatch (see `callerWarnings`).
export function detectVerbs(state: RepoState): readonly Verb[] {
  const enabled = new Set<Verb>();
  for (const caller of CALLERS) {
    if (state.callers[caller.file] !== undefined) enabled.add(caller.verb);
  }
  const scripts = state.packageJson?.scripts ?? {};
  for (const [name, command] of Object.entries(scripts)) {
    if (!name.startsWith("sandcastle:")) continue;
    for (const verb of VERBS) {
      // Matched on the command's first argument, which is exactly the verb, rather
      // than on the script name, which is ambiguous across hyphenated verbs.
      if (new RegExp(`\\b${PACKAGE_NAME}(?:\\.mjs)?\\s+${verb}(?:\\s|$)`).test(command)) {
        enabled.add(verb);
      }
    }
  }
  return VERBS.filter((verb) => enabled.has(verb));
}

// Warnings about the caller files: pins that point somewhere unexpected, verbs whose
// scripts and caller disagree, and the one case `sync` refuses to fix silently.
function callerWarnings(
  input: PlanInput,
  verbs: readonly Verb[],
  selected: readonly CallerSpec[],
): readonly Warning[] {
  const warnings: Warning[] = [];

  for (const caller of selected) {
    const content = input.state.callers[caller.file];
    if (content === undefined) {
      if (input.mode === "sync") {
        warnings.push({
          message: `${verbLabel(caller.verb)} has hook scripts but no ${caller.file} — nothing will trigger it.`,
          fix: `run \`agent-workflows init --verbs=${caller.verb}\` to write the caller.`,
        });
      }
      continue;
    }
    const { from } = repinCaller(content, input.workflowsRepo, input.ref);
    if (from === null) {
      warnings.push({
        message: `${caller.file} does not call ${input.workflowsRepo} — leaving it untouched.`,
        fix: `check it \`uses:\` ${usesRef(caller, input.workflowsRepo, input.ref)}.`,
      });
    }
  }

  // A caller present for a verb that is NOT selected: on `init --verbs=…` that is a
  // narrowing the human may not have intended, and the installer will not delete a
  // workflow file to enact it.
  for (const caller of CALLERS) {
    if (verbs.includes(caller.verb)) continue;
    if (input.state.callers[caller.file] === undefined) continue;
    warnings.push({
      message: `${caller.file} is present but ${verbLabel(caller.verb)} was not selected — its hook scripts will be removed.`,
      fix: `include \`--verbs=${caller.verb}\` to keep it, or delete the caller file.`,
    });
  }

  return warnings;
}

function verbLabel(verb: Verb): string {
  return `\`${verb}\``;
}

// Overrides shadow the packaged entrypoint FOREVER and silently — a copy taken at
// v1.1 keeps running after the package moves to v1.5, and nothing about the update
// says so. The installer cannot tell a deliberate customisation from a stale copy, so
// it reports every one and leaves them all in place.
function overrideWarnings(state: RepoState, version: string): readonly Warning[] {
  if (state.overrides.length === 0) return [];
  return [
    {
      message: `${state.overrides.length} local override${
        state.overrides.length === 1 ? " shadows" : "s shadow"
      } the packaged v${version} defaults: ${state.overrides.join(", ")}.`,
      fix: "re-check each against the packaged version — an override never updates with the package.",
    },
  ];
}

function secretWarnings(state: RepoState, verbs: readonly Verb[]): readonly Warning[] {
  if (state.secrets === null) return [];
  const warnings: Warning[] = [];
  for (const secret of secretsFor(verbs)) {
    if (state.secrets.includes(secret.name)) continue;
    warnings.push({
      message: `${secret.name} is not set on this repo — ${secret.why}.`,
      // Never set for the human: the installer reads and writes no secret material,
      // and a PAT cannot be minted outside the GitHub UI anyway.
      fix: `set it with \`gh secret set ${secret.name}\` (or inherit it from the org).`,
    });
  }
  return warnings;
}

function toolchainWarnings(state: RepoState): readonly Warning[] {
  const warnings: Warning[] = [];
  if (!state.hasYarnLock) {
    warnings.push({
      message: "no yarn.lock — the workflow installs with a frozen lockfile.",
      fix: "run `yarn install` and commit the lockfile.",
    });
  }
  if (state.nodeVersion === null) {
    warnings.push({
      message: "no .node-version — the workflow needs a Node version from somewhere.",
      fix: "add a `.node-version` file, or pass `node-version:` on each caller.",
    });
  }
  return warnings;
}

export function buildPlan(input: PlanInput): Plan {
  const { state, mode } = input;

  // The central repo is the package, and it never installs itself: its hook scripts run
  // `node bin/agent-workflows.mjs` against its own source, which is exactly what
  // dogfooding the workflows requires. An install here would rewrite all of them to the
  // `agent-workflows` bin and add the package as a dependency on itself. Caught by name
  // because that is the one thing true of the central repo in every checkout, worktree
  // and fork of it.
  if (state.packageJson?.name === PACKAGE_NAME) {
    return blockedPlan(
      mode,
      [],
      "this checkout IS the agent-workflows package — it never installs itself. Run this in a consuming repo.",
    );
  }

  const detected = detectVerbs(state);
  // `init` defaults to the whole fleet — the verbs are independent, each costs nothing
  // until a label is applied, and a repo that installs half of them usually wanted all
  // of them. `sync` defaults to what is already there and adds nothing.
  const verbs = input.verbs ?? (mode === "init" ? [...VERBS] : detected);

  if (mode === "sync" && detected.length === 0 && input.verbs === null) {
    return blockedPlan(
      mode,
      verbs,
      "this repo has no agent-workflows callers or hook scripts yet — run `agent-workflows init` first.",
    );
  }
  if (mode === "sync" && state.packageJson === null) {
    return blockedPlan(
      mode,
      verbs,
      "no package.json — run `agent-workflows init` to create one.",
    );
  }

  const callerOptions: CallerOptions = {
    workflowsRepo: input.workflowsRepo,
    ref: input.ref,
    enableRuby: input.enableRuby,
    gitAuthorEmail: input.gitAuthorEmail,
    publicRepo: input.publicRepo,
  };

  const selected = callersFor(verbs);
  const writes: FileWrite[] = [];

  for (const caller of selected) {
    const path = `${WORKFLOW_DIR}/${caller.file}`;
    const existing = state.callers[caller.file];

    if (existing === undefined) {
      // `sync` never CREATES a caller: a verb is enabled by having one, so writing a
      // missing file would re-enable something the human disabled by deleting it. It
      // warns instead (see `callerWarnings`).
      if (mode === "sync") continue;
      writes.push({
        path,
        content: renderCaller(caller, callerOptions),
        reason: `write the ${caller.verb} caller`,
        existing: false,
      });
      continue;
    }

    // The file is there: move the pin and NOTHING else. The `with:` inputs are the
    // consumer's toolchain and the `if:` is their access policy — regenerating would
    // silently revert both.
    const repinned = repinCaller(existing, input.workflowsRepo, input.ref);
    if (repinned.from !== null && repinned.content !== existing) {
      writes.push({
        path,
        content: repinned.content,
        reason: `re-pin ${repinned.from} → ${input.ref}`,
        existing: true,
      });
    }
  }

  if (input.baseBranch !== null && !state.hasConfig) {
    writes.push({
      path: CONFIG_PATH,
      content: `${JSON.stringify({ baseBranch: input.baseBranch }, null, 2)}\n`,
      reason: `set the integration branch to ${input.baseBranch}`,
      existing: false,
    });
  }

  const packageJson = planPackageJson(input, verbs);
  const existingLabels = new Set(state.labels);
  const labels = labelsFor(verbs).filter((label) => !existingLabels.has(label));

  const warnings = [
    ...callerWarnings(input, verbs, selected),
    ...overrideWarnings(state, input.packagedVersion),
    ...secretWarnings(state, verbs),
    ...toolchainWarnings(state),
  ];

  const notes: string[] = [];
  if (mode === "sync" && input.verbs === null) {
    notes.push(`detected verbs: ${detected.join(", ")}`);
  }
  notes.push(
    "issue-triggered callers only fire from the default branch — commit and merge these before labelling anything.",
  );

  return {
    mode,
    verbs,
    writes,
    packageJson,
    labels,
    install: packageJson?.dependency.from !== packageJson?.dependency.to,
    warnings,
    notes,
    blocked: null,
  };
}

function blockedPlan(mode: Mode, verbs: readonly Verb[], reason: string): Plan {
  return {
    mode,
    verbs,
    writes: [],
    packageJson: null,
    labels: [],
    install: false,
    warnings: [],
    notes: [],
    blocked: reason,
  };
}

// The merged `package.json`, or null when it already says everything it should.
function planPackageJson(input: PlanInput, verbs: readonly Verb[]): Plan["packageJson"] {
  const created = input.state.packageJson === null;
  // A repo with no package.json is the normal case for a Rails or Go consumer: the
  // hooks are Node, the app is not. A minimal private manifest is enough to hang the
  // dependency and the scripts off, and `yarn` needs nothing more.
  const existing: PackageJson = input.state.packageJson ?? { private: true };

  const desired = consumerScripts(input.packagedScripts, verbs);
  const scripts = mergeScripts(existing.scripts ?? {}, desired);

  const spec = dependencySpec(input.workflowsRepo, input.ref);
  // Read from both dependency maps: the README puts the package in `devDependencies`,
  // but a consumer who put it in `dependencies` should have that one moved, not a
  // second copy added in the other map.
  const currentDev = existing.devDependencies?.[PACKAGE_NAME];
  const currentProd = existing.dependencies?.[PACKAGE_NAME];
  const current = currentDev ?? currentProd;

  const devDependencies = { ...(existing.devDependencies ?? {}), [PACKAGE_NAME]: spec };
  const dependencies = { ...(existing.dependencies ?? {}) };
  delete (dependencies as Record<string, string>)[PACKAGE_NAME];

  const content: PackageJson = {
    ...existing,
    scripts: scripts.scripts,
    devDependencies,
    ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
  };
  if (Object.keys(dependencies).length === 0 && existing.dependencies !== undefined) {
    delete (content as Record<string, unknown>).dependencies;
  }

  const unchanged =
    !created &&
    current === spec &&
    scripts.added.length === 0 &&
    scripts.changed.length === 0 &&
    scripts.removed.length === 0 &&
    currentProd === undefined;

  if (unchanged) return null;

  return {
    content,
    scripts,
    dependency: { from: refFromSpec(current), to: input.ref },
    created,
  };
}
