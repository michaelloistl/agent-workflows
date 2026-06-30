// Branch-ref parsing for the PRD orchestrator. Branch names are a parsed contract
// (CONTEXT.md): a PRD branch is `agent/prd-<n>-<slug>` and a tracer-bullet branch
// is `agent/issue-<n>-<slug>`. The advance caller discriminates on the base ref
// and derives the PRD number from it; the tracer-bullet number comes from the head
// ref. Pure string functions — no `gh`, no GitHub.

const PRD_BRANCH = /^agent\/prd-(\d+)(?:-|$)/;
const ISSUE_BRANCH = /^agent\/issue-(\d+)(?:-|$)/;

function numberFrom(ref: string, pattern: RegExp): number | null {
  const match = pattern.exec(ref);
  return match ? Number(match[1]) : null;
}

// True when `ref` is a PRD branch (`agent/prd-<n>-…`).
export function isPrdBranch(ref: string): boolean {
  return PRD_BRANCH.test(ref);
}

// The PRD number encoded in a PRD branch ref, or null when `ref` isn't one.
export function prdNumberFromBranch(ref: string): number | null {
  return numberFrom(ref, PRD_BRANCH);
}

// The issue number encoded in a tracer-bullet branch ref, or null when `ref`
// isn't one.
export function issueNumberFromBranch(ref: string): number | null {
  return numberFrom(ref, ISSUE_BRANCH);
}

// The live PRD branch for `prd` among `branchNames` (the repo's heads), or null
// when none exists. Used by `implement`'s fetch-spec to derive a tracer-bullet's
// base — the PRD branch when its parent PRD has one, else the default branch.
export function pickPrdBranch(prd: number, branchNames: string[]): string | null {
  return branchNames.find((name) => prdNumberFromBranch(name) === prd) ?? null;
}
