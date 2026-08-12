// The PROGRESS COMMENT kickoff and advance post on the spec issue. Pure: given the
// tracer-bullets, which are closed, and which (if any) was just dispatched, render the
// markdown. No `gh`.
//
// Markdown for a GitHub comment, and nothing else: the terminal status view renders the
// same data through its own renderer (ADR-0007), because one function serving both a
// comment body and an aligned terminal table makes both worse.

import { orderWithDeadlocked, type TracerBullet } from "./spec-graph.mts";

export interface ProgressView {
  branch: string;
  bullets: TracerBullet[];
  closed: Set<number>;
  dispatched: number | null;
}

export function renderProgress({ branch, bullets, closed, dispatched }: ProgressView): string {
  const { ordered, deadlocked } = orderWithDeadlocked(bullets);
  // A blocker the rules could not order on (another repository's issue — see
  // `spec-tree.foreignBlockers`) is named on its slice. The orchestrator dispatches that
  // slice as though nothing gated it, which is only safe if a human can see what it
  // decided not to wait for.
  const foreign = new Map(
    bullets
      .filter((b) => b.foreignBlockers?.length)
      .map((b) => [b.number, ` ⚠ waits on ${b.foreignBlockers!.join(", ")}`]),
  );
  const lines = ordered.map((n) => {
    const box = closed.has(n) ? "[x]" : "[ ]";
    const tag = n === dispatched ? " ◀ building" : "";
    return `- ${box} #${n}${tag}${foreign.get(n) ?? ""}`;
  });
  // Slices left out of the topological order are in a dependency cycle — surface
  // them rather than silently dropping them.
  const cycled = deadlocked.map(
    (n) => `- [ ] #${n} ⚠ blocked (dependency cycle)${foreign.get(n) ?? ""}`,
  );
  return [
    `**spec orchestration** on \`${branch}\` — strictly sequential, one slice at a time.`,
    "",
    ...lines,
    ...cycled,
  ].join("\n");
}
