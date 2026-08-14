// The consumer's `sandcastle:*` scripts — DERIVED from the packaged package.json
// rather than transcribed into a table here.
//
// The central repo is its own first consumer, so its own scripts already spell out
// every (verb, hook) pair the workflows invoke, including the asymmetric ones a
// hand-written matrix gets wrong: `explore` has a `-sequence` but no
// `-guards-sequence`, the PR verbs have a `-guards-sequence` but no plain
// `-sequence`, and `implement-spec` has `kickoff`/`advance` instead of hooks. Reading
// them means a hook added to this repo reaches every consumer on their next `sync`,
// with no second list to keep in step.
//
// The one difference is how the bin is reached: the central repo never installs
// itself, so it runs `node bin/agent-workflows.mjs`; a consumer has the package in
// `node_modules` and runs the `agent-workflows` bin on the yarn PATH.

import type { Installable } from "./catalog.mts";

// How the central repo's own scripts invoke the dispatcher. Located by the bin path
// (not by a `node ` prefix) so the split keeps working if the invocation ever picks up
// a flag or a different runtime in front of it.
const PACKAGED_BIN = "bin/agent-workflows.mjs";

// The bin as a consumer reaches it: yarn puts `node_modules/.bin` on PATH.
const CONSUMER_BIN = "agent-workflows";

// A script that goes through the dispatcher, however it reaches the bin —
// `agent-workflows <verb>`, `node bin/agent-workflows.mjs <verb>`, `yarn agent-workflows
// <verb>`. The first argument after the bin is exactly what the dispatcher classifies.
const DISPATCHER = /(?:^|[\s/])agent-workflows(?:\.mjs)?\s+([\w-]+)/;

// The verb a script drives, or null when it does not call the dispatcher at all.
//
// Read from the COMMAND, never the script name: `sandcastle:implement-spec-kickoff`
// could be read as verb `implement` with hook `spec-kickoff`, while the command says
// which it is. It is also how the installer tells its own scripts from a consumer's.
export function dispatcherVerb(command: string): string | null {
  const match = DISPATCHER.exec(command);
  return match ? match[1] : null;
}

export interface DerivedScript {
  readonly name: string;
  readonly command: string;
  readonly verb: string;
}

// Every `sandcastle:*` script the packaged package.json defines, with the verb each
// one drives read from the COMMAND, not the script name. The name is ambiguous —
// `sandcastle:implement-spec-kickoff` could be verb `implement` with hook
// `spec-kickoff` — while the command's first argument is exactly the verb the
// dispatcher will classify.
export function derivePackagedScripts(
  packagedScripts: Readonly<Record<string, string>>,
): readonly DerivedScript[] {
  const derived: DerivedScript[] = [];
  for (const [name, command] of Object.entries(packagedScripts)) {
    if (!name.startsWith("sandcastle:")) continue;
    const at = command.indexOf(PACKAGED_BIN);
    // A `sandcastle:*` script that does not go through the dispatcher is something
    // this repo does for itself; it is not part of the contract, so it is not copied.
    if (at === -1) continue;
    const tail = command.slice(at + PACKAGED_BIN.length).trim();
    if (!tail) continue;
    const verb = tail.split(/\s+/)[0];
    if (!verb) continue;
    derived.push({ name, command: `${CONSUMER_BIN} ${tail}`, verb });
  }
  return derived;
}

// The scripts a consumer that enabled `verbs` should have, in the packaged order.
export function consumerScripts(
  packagedScripts: Readonly<Record<string, string>>,
  verbs: readonly Installable[],
): Record<string, string> {
  const scripts: Record<string, string> = {};
  for (const script of derivePackagedScripts(packagedScripts)) {
    if (!(verbs as readonly string[]).includes(script.verb)) continue;
    scripts[script.name] = script.command;
  }
  return scripts;
}

export interface ScriptMerge {
  readonly scripts: Record<string, string>;
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
}

// Merge the desired scripts into a consumer's existing ones.
//
// What the installer owns is not the `sandcastle:` namespace — `.sandcastle/` is the
// consumer's own hook layer and a repo may keep its own `sandcastle:seed` there — but
// the scripts that CALL THE DISPATCHER. Those it owns wholesale, because a stale one
// left behind by a removed verb or a renamed hook is worse than a missing one: the
// workflow calling it fails at the point of use rather than at install time. So a
// `sandcastle:*` key whose command calls `agent-workflows` and is no longer desired is
// REMOVED, and every other key — inside the namespace or out of it — is left exactly
// as it was.
//
// A consumer who wants a different implementation for one hook overrides the
// entrypoint under `.sandcastle/agent-workflows/` — the seam the dispatcher already
// resolves — rather than editing the script, which is why rewriting these is safe.
export function mergeScripts(
  existing: Readonly<Record<string, string>>,
  desired: Readonly<Record<string, string>>,
): ScriptMerge {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  const scripts: Record<string, string> = {};

  for (const [name, command] of Object.entries(existing)) {
    if (name.startsWith("sandcastle:") && dispatcherVerb(command) !== null && !(name in desired)) {
      removed.push(name);
      continue;
    }
    scripts[name] = command;
  }
  for (const [name, command] of Object.entries(desired)) {
    if (!(name in existing)) added.push(name);
    else if (existing[name] !== command) changed.push(name);
    scripts[name] = command;
  }

  return { scripts, added, changed, removed };
}

// The git-dependency spec a consumer pins. No registry: the package is installed
// straight from GitHub, so the "version" is a git ref — a moving major tag (`v1`) to
// track compatible releases, or an exact tag/SHA to freeze.
export function dependencySpec(repo: string, ref: string): string {
  return `github:${repo}#${ref}`;
}

// The ref out of a dependency spec, or null when the spec is not one of ours. Used to
// report what a repo is currently pinned at before `sync` moves it.
export function refFromSpec(spec: string | undefined): string | null {
  if (!spec) return null;
  const hash = spec.lastIndexOf("#");
  if (!spec.startsWith("github:") || hash === -1) return null;
  return spec.slice(hash + 1);
}
