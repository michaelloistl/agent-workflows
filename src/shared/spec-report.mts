// The spec progress comment — the dashboard kickoff and advance post on the spec
// issue. Pure: given the tracer-bullets, which are closed, and which (if any) was
// just dispatched, render the markdown. No `gh`.

import { topologicalOrder, type TracerBullet } from "./spec-graph.mts";

export interface ProgressView {
  branch: string;
  bullets: TracerBullet[];
  closed: Set<number>;
  dispatched: number | null;
}

export function renderProgress({ branch, bullets, closed, dispatched }: ProgressView): string {
  const order = topologicalOrder(bullets);
  const inOrder = new Set(order);
  const lines = order.map((n) => {
    const box = closed.has(n) ? "[x]" : "[ ]";
    const tag = n === dispatched ? " ◀ building" : "";
    return `- ${box} #${n}${tag}`;
  });
  // Slices left out of the topological order are in a dependency cycle — surface
  // them rather than silently dropping them.
  const deadlocked = bullets
    .filter((b) => !inOrder.has(b.number))
    .map((b) => `- [ ] #${b.number} ⚠ blocked (dependency cycle)`);
  return [
    `**spec orchestration** on \`${branch}\` — strictly sequential, one slice at a time.`,
    "",
    ...lines,
    ...deadlocked,
  ].join("\n");
}
