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
  const lines = ordered.map((n) => {
    const box = closed.has(n) ? "[x]" : "[ ]";
    const tag = n === dispatched ? " ◀ building" : "";
    return `- ${box} #${n}${tag}`;
  });
  // Slices left out of the topological order are in a dependency cycle — surface
  // them rather than silently dropping them.
  const cycled = deadlocked.map((n) => `- [ ] #${n} ⚠ blocked (dependency cycle)`);
  return [
    `**spec orchestration** on \`${branch}\` — strictly sequential, one slice at a time.`,
    "",
    ...lines,
    ...cycled,
  ].join("\n");
}
