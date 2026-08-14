// Flags for `agent-workflows init` / `agent-workflows sync`.
//
// Pure, like the status view's option parsing: the entry point owns `process.argv` and
// the environment, this owns what the flags MEAN. Every value the plan needs either
// comes from a flag here or is detected from the repo — there is no interactive
// questionnaire, because a setup command that can only be driven by answering six
// prompts cannot be put in a script or handed to an agent.

import type { Verb } from "./catalog.mts";
import { VERBS, isVerb } from "./catalog.mts";

export interface InstallOptions {
  // Null means "decide from the repo": every verb on `init`, the already-enabled ones
  // on `sync`.
  readonly verbs: readonly Verb[] | null;
  // Null means "the major version of the package doing the installing".
  readonly ref: string | null;
  // Null means "the packaged default, or the repo's Gemfile" — see the entry point.
  readonly enableRuby: boolean | null;
  // Null means "this checkout's `git config user.email`".
  readonly gitAuthorEmail: string | null;
  readonly workflowsRepo: string | null;
  readonly baseBranch: string | null;
  // Print the plan and stop. Changes nothing, needs no confirmation.
  readonly dryRun: boolean;
  // Pre-accept the plan. Without it a non-interactive stdin DECLINES, so a scripted
  // run cannot start a repo-modifying install by accident.
  readonly yes: boolean;
}

export type ParsedOptions =
  | { readonly ok: true; readonly options: InstallOptions }
  | { readonly ok: false; readonly message: string };

const FLAGS_WITH_VALUES = [
  "verbs",
  "ref",
  "email",
  "workflows-repo",
  "base-branch",
] as const;

export function parseInstallArgs(args: readonly string[]): ParsedOptions {
  let verbs: readonly Verb[] | null = null;
  let ref: string | null = null;
  let enableRuby: boolean | null = null;
  let gitAuthorEmail: string | null = null;
  let workflowsRepo: string | null = null;
  let baseBranch: string | null = null;
  let dryRun = false;
  let yes = false;

  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      yes = true;
      continue;
    }
    // Both spellings, because "is Ruby on?" has a real default per repo (a Gemfile)
    // and a consumer needs to be able to say "no" against it as well as "yes".
    if (arg === "--enable-ruby") {
      enableRuby = true;
      continue;
    }
    if (arg === "--no-enable-ruby") {
      enableRuby = false;
      continue;
    }

    const match = /^--([\w-]+)=(.*)$/.exec(arg);
    if (!match) {
      // A valueless `--flag` is reported as a flag, not as a stray argument — and if
      // it is one of ours, as one that was given the wrong way round. These flags take
      // their value with `=` only, so `--ref v1` would otherwise silently drop `v1`.
      const bare = /^--([\w-]+)$/.exec(arg);
      if (bare && (FLAGS_WITH_VALUES as readonly string[]).includes(bare[1])) {
        return { ok: false, message: `\`--${bare[1]}\` takes its value as \`--${bare[1]}=<value>\`` };
      }
      if (bare) return { ok: false, message: `unrecognised flag \`${arg}\`` };
      return { ok: false, message: `unrecognised argument \`${arg}\`` };
    }
    const [, name, value] = match;
    if (!(FLAGS_WITH_VALUES as readonly string[]).includes(name)) {
      return { ok: false, message: `unrecognised flag \`--${name}\`` };
    }
    if (value === "") {
      return { ok: false, message: `\`--${name}\` needs a value` };
    }

    switch (name) {
      case "verbs": {
        const requested = value.split(",").map((v) => v.trim()).filter((v) => v !== "");
        const unknown = requested.filter((v) => !isVerb(v));
        if (unknown.length > 0) {
          return {
            ok: false,
            message: `unknown verb${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")} — known verbs are ${VERBS.join(", ")}`,
          };
        }
        // Deduplicated and put back in catalog order, so `--verbs=implement,explore`
        // and `--verbs=explore,implement` plan identically.
        verbs = VERBS.filter((v) => requested.includes(v));
        break;
      }
      case "ref":
        ref = value;
        break;
      case "email":
        gitAuthorEmail = value;
        break;
      case "workflows-repo":
        if (!/^[\w.-]+\/[\w.-]+$/.test(value)) {
          return { ok: false, message: `\`--workflows-repo\` must be owner/name, got \`${value}\`` };
        }
        workflowsRepo = value;
        break;
      case "base-branch":
        baseBranch = value;
        break;
    }
  }

  return {
    ok: true,
    options: { verbs, ref, enableRuby, gitAuthorEmail, workflowsRepo, baseBranch, dryRun, yes },
  };
}

// The major-version ref a package at `version` installs by default: `1.5.0` → `v1`.
//
// A moving major tag is the right default pin because the compatibility promise is at
// the major: a consumer tracking `v1` picks up a new hook on their next `sync` without
// re-pinning, and a breaking change cannot reach them without one.
export function defaultRef(version: string): string {
  const major = version.split(".")[0];
  return /^\d+$/.test(major) ? `v${major}` : version;
}
