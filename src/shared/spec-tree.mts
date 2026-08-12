// The shared reader behind the STATUS VIEW (ADR-0007): given a repo's issues and its
// remote branch names, which specs are in flight and what state each of their
// tracer-bullets is in. Pure — no `gh`, no `git`. `spec-tracker.mts` fetches the raw
// records; this decides what they mean, and `status/render.mts` decides how they look.
//
// It is deliberately NOT private to the status view. The orchestrator resolves the same
// tree today through `spec-graph`, and when native sub-issue parents are WRITTEN rather
// than merely read (issue #96 pilots the read) it migrates onto this reader — a pilot
// running on its own private reader would prove nothing about the code that matters.
//
// Discovery is by BRANCH, not by label: `kickoff` removes `agent:implement-spec` the
// moment it fires, so no label distinguishes a running spec, and walking up from
// labelled slices cannot see a spec whose slices have ALL closed — which is precisely
// the state most in need of a human. An open spec issue with a live `agent/spec-*`
// branch is exactly the in-flight set; requiring the ISSUE to be open excludes the
// ghost branches that outlive a finished spec.

import { pickSpecBranch } from "./spec-context.mts";
import { orderWithDeadlocked, tracerBullets } from "./spec-graph.mts";

// One issue as the tracker hands it over. `labels` is label NAMES only — the view
// never reads a triage label (`ready-for-agent` here, `ready-for-afk` elsewhere), so
// that drift cannot reach it.
export interface IssueRecord {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: "OPEN" | "CLOSED";
  readonly labels: readonly string[];
  readonly url: string;
}

// A tracer-bullet's state, from its issue state and `agent:*` labels ONLY — no PR or
// check-run join (ADR-0007).
export type SliceState = "done" | "building" | "review" | "blocked" | "pending";

export interface SliceNode {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: SliceState;
  // Left out of the topological order, i.e. in a dependency cycle. Orthogonal to
  // `state`, which stays what the tracker says; the renderer flags it either way.
  readonly cycle: boolean;
}

// `awaiting-final-pr`: every slice closed while the spec issue is still open — the
// spec branch holds the whole feature and the one human gate is the final
// spec→default PR.
export type SpecState = "building" | "awaiting-final-pr";

export interface SpecNode {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly branch: string;
  readonly state: SpecState;
  readonly closed: number;
  readonly total: number;
  readonly slices: readonly SliceNode[];
}

// Loudest first: a slice that is both closed and still carrying a stale state label is
// done, and `agent:blocked` outranks the rest because it is the one state that means
// stop and look.
function sliceState(issue: IssueRecord): SliceState {
  if (issue.state === "CLOSED") return "done";
  if (issue.labels.includes("agent:blocked")) return "blocked";
  if (issue.labels.includes("agent:in-progress")) return "building";
  if (issue.labels.includes("agent:review")) return "review";
  return "pending";
}

export function buildSpecTree(
  issues: readonly IssueRecord[],
  branches: readonly string[],
): SpecNode[] {
  const byNumber = new Map(issues.map((i) => [i.number, i]));

  return issues
    .filter((i) => i.state === "OPEN")
    .map((i) => ({ issue: i, branch: pickSpecBranch(i.number, branches) }))
    .filter((c): c is { issue: IssueRecord; branch: string } => c.branch !== null)
    .sort((a, b) => a.issue.number - b.issue.number)
    .map(({ issue, branch }) => {
      const bullets = tracerBullets(issue.number, issues);
      // Deadlocked slices go last rather than vanishing: the orchestrator will never
      // dispatch them, which is exactly why they have to show.
      const { ordered, deadlocked } = orderWithDeadlocked(bullets);
      const inOrder = new Set(ordered);
      const cycled = [...deadlocked].sort((a, b) => a - b);

      const slices = [...ordered, ...cycled].map((n): SliceNode => {
        const bullet = byNumber.get(n)!;
        return {
          number: n,
          title: bullet.title,
          url: bullet.url,
          state: sliceState(bullet),
          cycle: !inOrder.has(n),
        };
      });

      const closed = slices.filter((s) => s.state === "done").length;
      return {
        number: issue.number,
        title: issue.title,
        url: issue.url,
        branch,
        // Guarded against vacuous truth: a spec with no slices at all has not finished
        // them, it has none.
        state: slices.length > 0 && closed === slices.length ? "awaiting-final-pr" : "building",
        closed,
        total: slices.length,
        slices,
      } satisfies SpecNode;
    });
}
