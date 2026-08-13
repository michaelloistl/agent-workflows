// The `gh`/`git` steps of advancing a spec, shared by the unattended `advance`
// hook (implement-spec/advance.mts) and the attended spec loop (sequencer/
// spec-loop-run.mts). Extracted so the two paths run the IDENTICAL close / final-PR
// / spec-branch-CI code and cannot drift — the guarantee behind "a locally run spec
// produces the same git history and tracker state as the same spec run in CI"
// (issue #59). Thin `gh` wrappers over tracker-aware work; kept out of the central
// YAML (ADR-0001), so a Linear repo swaps this behind the same hooks.

import { capture } from "./process.mts";
import { parseChecks, parseCommitCheckRuns, type CheckRun } from "./checks.mts";
import { resolveConfig } from "./config.mts";
import { addLabel, ensureLabel } from "./github.mts";

// The review verb's trigger label, applied to the final spec→default PR so the
// `review-pr` thin caller fires its advisory review on it (issue #114). The same
// string the review guards/status hooks key on.
const REVIEW_TRIGGER_LABEL = "agent:review-pr";
const REVIEW_TRIGGER_LABEL_DESCRIPTION = "Triggers an advisory agent review of this PR.";

// Close a merged tracer-bullet (merging into a non-default base does NOT auto-close
// it). Best-effort: an already-closed issue or a race with a re-run must not fail
// the advance — closing is deliberately failure-tolerant, which is exactly why a
// tracer-bullet's closed state is not trusted as proof that its slice landed.
export function closeTracerBullet(issue: number, base: string): void {
  try {
    capture("gh", ["issue", "close", String(issue), "--comment", `Merged into \`${base}\`.`]);
  } catch {
    /* already closed / a race with a re-run must not fail advance */
  }
}

// The single human-review gate: a draft PR from the spec branch to the configured
// base branch with `Closes #<spec>` (base IS where the spec lands, so the merge
// auto-closes the spec). The base is the configured base branch (issue #53),
// falling back to the repository default when no config file sets one — matching
// where kickoff cut the spec branch from. Idempotent — never opens a second final PR.
//
// The review trigger label is applied as a DISTINCT write after the PR exists (issue
// #114) — not as part of `pr create`, because the thin caller triggers on the label
// event and it is not established that creating a PR with a label already attached
// emits one. It is applied ONLY on this create path: a run that finds the final PR
// already open (the early return below) leaves it alone, since the review verb retires
// its own trigger label when it starts and re-applying it would fire a second full
// review on every later advance. The label is ensured to exist in the repo first,
// since label edits are best-effort and would otherwise fail silently in a repo that
// has never created it. A consuming repo turns the review off with `finalPrReview`.
export function openFinalPr(specNumber: number, specBranch: string): void {
  const config = resolveConfig();
  const base =
    config.baseBranch ||
    capture("gh", [
      "repo",
      "view",
      "--json",
      "defaultBranchRef",
      "-q",
      ".defaultBranchRef.name",
    ]).trim();
  const existing = capture("gh", [
    "pr",
    "list",
    "--head",
    specBranch,
    "--base",
    base,
    "--state",
    "open",
    "--json",
    "number",
    "-q",
    ".[].number",
  ]).trim();
  if (existing) {
    console.log(`Final PR already open (#${existing}).`);
    return;
  }
  const title = capture("gh", ["issue", "view", String(specNumber), "--json", "title", "-q", ".title"]).trim();
  const body = `Automated by the implement-spec orchestrator: every tracer-bullet of spec #${specNumber} is merged into \`${specBranch}\`. This is the single human-review gate for the whole feature.\n\nCloses #${specNumber}`;
  const url = capture("gh", [
    "pr",
    "create",
    "--draft",
    "--base",
    base,
    "--head",
    specBranch,
    "--title",
    title,
    "--body",
    body,
  ]).trim();

  // Label the final PR for review — a distinct write after it exists, gated on
  // `finalPrReview` (issue #114). Ensure the label first, then apply it, so the
  // tracker emits the label event the `review-pr` thin caller triggers on.
  if (config.finalPrReview) {
    const pr = url.match(/\/pull\/(\d+)/)?.[1];
    if (pr) {
      ensureLabel(REVIEW_TRIGGER_LABEL, REVIEW_TRIGGER_LABEL_DESCRIPTION);
      addLabel("pr", pr, REVIEW_TRIGGER_LABEL);
    } else {
      // The whole feature is "the review actually starts", so a no-match must not
      // vanish silently — `gh pr create` reliably prints the PR URL, but if its
      // output ever changes shape this line is the only trace of the skipped review.
      console.warn(`Could not parse the final PR number from \`gh pr create\` output (${url}); skipped the \`${REVIEW_TRIGGER_LABEL}\` label, so no review will start.`);
    }
  }
}

// Read the check-runs on the spec branch's tip. The branch has no open PR (the
// final PR opens only once every slice is done), so `gh pr checks` doesn't apply —
// resolve the branch to its tip SHA, then read that commit's check-runs over the
// REST API. Two calls because a branch name can contain slashes (`agent/spec-…`):
// `git/ref/heads/<branch>` takes the full multi-segment ref, but the SHA it
// returns is the slash-free key `commits/{ref}/check-runs` needs. Tolerant of a gh
// error the same way finalize tolerates `gh pr checks`: an empty parse → verdict
// "none", which the poll loop's grace window resolves rather than hanging.
export function fetchSpecChecks(branch: string): CheckRun[] {
  try {
    const sha = capture("gh", [
      "api",
      `repos/{owner}/{repo}/git/ref/heads/${branch}`,
      "--jq",
      ".object.sha",
    ]).trim();
    if (!sha) return [];
    return parseCommitCheckRuns(
      capture("gh", ["api", `repos/{owner}/{repo}/commits/${sha}/check-runs`]),
    );
  } catch (err) {
    return parseCommitCheckRuns((err as { stdout?: string }).stdout ?? "");
  }
}

// Read the check-runs on a slice PR (its own CI), tolerant of gh's non-zero exit
// exactly as implement-finalize is: `gh pr checks` still prints the JSON we asked
// for even when it exits non-zero (checks pending/failing/absent). Used when the
// attended loop RESUMES at a slice's gate — an open PR left by an interrupted run is
// gated and merged here rather than re-running the agent (issue #60).
export function fetchSlicePrChecks(pr: number): CheckRun[] {
  try {
    return parseChecks(capture("gh", ["pr", "checks", String(pr), "--json", "name,state,bucket"]));
  } catch (err) {
    return parseChecks((err as { stdout?: string }).stdout ?? "");
  }
}

// Merge an open slice PR straight into the spec branch — the merge implement-finalize
// would have run, replayed by the attended loop when it resumes at a slice's gate
// (issue #60). Deletes the head branch, matching the finalize path.
export function mergeSlicePr(pr: number): void {
  capture("gh", ["pr", "merge", String(pr), "--merge", "--delete-branch"]);
}

// Why the run halts when the spec branch's tip CI does not pass after the last
// tracer-bullet merged. `blocked` is the slice that was NOT dispatched (a number on
// the advance gate; null carries through the shared action shape). `RUN_URL` is
// appended when set (the unattended path); an attended local run has none.
export function specBranchHaltMessage(branch: string, blocked: number | null): string {
  const runUrl = process.env.RUN_URL;
  const tail = runUrl ? `\n\nSee the run: ${runUrl}` : "";
  return (
    `⛔ CI on the spec branch \`${branch}\` did not pass at its tip after the last ` +
    `tracer-bullet merged (a check failed, or none went green before the timeout), ` +
    `so the next slice${blocked === null ? "" : ` (#${blocked})`} was **not** dispatched. ` +
    `Fix the spec branch — or roll back the last merge — then re-run to continue.${tail}`
  );
}
