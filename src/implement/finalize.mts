// `implement-finalize` hook. Open the PR for the pushed `agent/…` branch with the
// tracker cross-reference (`Closes #N`) and apply the terminal label. PR *creation*
// is a hook (not the central workflow) because the cross-ref and base are
// tracker-aware (ADR-0001, Decision 7).
//
// Two shapes, keyed on whether the base is a spec branch (the stacked topology):
//   standalone → DRAFT PR to the default branch + `agent:review` (human gate).
//   under spec  → READY PR to the spec branch, MERGED straight in (which fires
//                advance) — but only once the PR's own CI is green (issue #44,
//                fix 1). No per-slice review (ADR-0004): the implement agent's own
//                test loop plus this CI gate are the per-slice gates; the final
//                spec→default PR is the human gate. The in-progress label is
//                cleared (`done`). If CI fails or never goes green in time the
//                slice is NOT merged — the PR is left as a draft and the run exits
//                non-zero so a human picks it up (`agent:blocked`).
import { required, capture } from "../shared/process.mts";
import { setState, comment } from "../shared/github.mts";
import { isSpecBranch } from "../shared/spec-context.mts";
import { parseChecks, type CheckRun } from "../shared/checks.mts";
import { awaitChecks } from "../shared/poll-checks.mts";

const number = required("ISSUE_NUMBER");
const title = required("ISSUE_TITLE");
const branch = required("BRANCH");
const base = process.env.BASE ?? "";
const underSpec = isSpecBranch(base);

const body = `Automated by the agent-implement workflow for #${number}.\n\nCloses #${number}`;
const args = ["pr", "create", "--head", branch, "--title", title, "--body", body];
if (base) args.push("--base", base);
if (!underSpec) args.push("--draft");
const url = capture("gh", args).trim();

if (underSpec) {
  const pr = url.match(/\/pull\/(\d+)/)?.[1];
  if (!pr) {
    // Should never happen (we just created the PR), but never silently merge on a
    // guess — fail loudly so the branch is inspected rather than left half-wired.
    console.error(`Issue #${number}: could not parse a PR number from ${url}.`);
    process.exit(1);
  }
  // Gate the merge on the tracer PR's own CI (issue #44, fix 1).
  const passed = await awaitChecks(() => fetchChecks(pr));
  if (passed) {
    // Merge the slice straight into the spec branch (strictly sequential, so it's
    // always clean). The merge fires advance, which closes this issue and
    // dispatches the next slice — or opens the final PR.
    capture("gh", ["pr", "merge", pr, "--merge", "--delete-branch"]);
    setState("issue", number, "done");
    console.log(
      `Issue #${number}: opened ready PR #${pr} from ${branch} → ${base}, CI passed, merged it.`,
    );
  } else {
    // CI failed or never went green in time. Do NOT merge onto the spec branch —
    // that is exactly the cascade this gate exists to stop. Convert the PR to a
    // draft, explain why on the PR, and exit non-zero so the workflow's failure
    // handler marks the issue `agent:blocked` for a human to pick up.
    tryDraft(pr);
    comment(
      "pr",
      pr,
      `Tracer-bullet CI did not pass, so this slice was not auto-merged into \`${base}\`. Resolve the failing checks (or merge manually) to continue the spec.`,
    );
    console.error(
      `Issue #${number}: tracer PR #${pr} CI did not pass — left open as a draft, not merged.`,
    );
    process.exit(1);
  }
} else {
  // Standalone: a draft PR awaiting human review.
  setState("issue", number, "review");
  console.log(
    `Issue #${number}: opened draft PR from ${branch} → ${base || "(default)"}.`,
  );
}

// `gh pr checks` exits non-zero when checks are failing, pending, or absent — but
// still prints the JSON we asked for (empty when there are no checks). Tolerate the
// exit and parse whatever landed on stdout.
function fetchChecks(pr: string): CheckRun[] {
  try {
    return parseChecks(
      capture("gh", ["pr", "checks", pr, "--json", "name,state,bucket"]),
    );
  } catch (err) {
    return parseChecks((err as { stdout?: string }).stdout ?? "");
  }
}

// Best-effort convert-to-draft — a failure here must not mask the CI-failure exit.
function tryDraft(pr: string): void {
  try {
    capture("gh", ["pr", "ready", pr, "--undo"]);
  } catch {
    /* tolerate: leaving the PR ready with red checks is still a safe human gate */
  }
}
