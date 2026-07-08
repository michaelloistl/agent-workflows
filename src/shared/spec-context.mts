// Branch-ref parsing for the spec orchestrator. Branch names are a parsed contract
// (CONTEXT.md): a spec branch is `agent/spec-<n>-<slug>` and a tracer-bullet branch
// is `agent/issue-<n>-<slug>`. The advance caller discriminates on the base ref
// and derives the spec number from it; the tracer-bullet number comes from the head
// ref. Pure string functions — no `gh`, no GitHub.

const SPEC_BRANCH = /^agent\/spec-(\d+)(?:-|$)/;
const ISSUE_BRANCH = /^agent\/issue-(\d+)(?:-|$)/;

function numberFrom(ref: string, pattern: RegExp): number | null {
  const match = pattern.exec(ref);
  return match ? Number(match[1]) : null;
}

// True when `ref` is a spec branch (`agent/spec-<n>-…`).
export function isSpecBranch(ref: string): boolean {
  return SPEC_BRANCH.test(ref);
}

// The spec number encoded in a spec branch ref, or null when `ref` isn't one.
export function specNumberFromBranch(ref: string): number | null {
  return numberFrom(ref, SPEC_BRANCH);
}

// The issue number encoded in a tracer-bullet branch ref, or null when `ref`
// isn't one.
export function issueNumberFromBranch(ref: string): number | null {
  return numberFrom(ref, ISSUE_BRANCH);
}

// The live spec branch for `spec` among `branchNames` (the repo's heads), or null
// when none exists. Used by `implement`'s fetch-spec to derive a tracer-bullet's
// base — the spec branch when its parent spec has one, else the default branch.
export function pickSpecBranch(spec: number, branchNames: string[]): string | null {
  return branchNames.find((name) => specNumberFromBranch(name) === spec) ?? null;
}
