// Markdown section parsing shared by the agent-workflow hooks. Tracer-bullet and
// PRD issue bodies use `## <heading>` sections (`## Parent`, `## Blocked by`); the
// orchestrator and the `implement` blocked-by guard both need to read one section
// without tripping on `#N` references elsewhere in the body.

// Return the text under a `## <heading>` section (case-insensitive, level-2 only),
// from the heading line until the next `## ` heading. "" when the section is absent.
export function section(body: string, heading: string): string {
  const wanted = heading.trim().toLowerCase();
  const lines: string[] = [];
  let capturing = false;
  for (const line of body.split("\n")) {
    const headingText = /^##\s+(.+?)\s*$/.exec(line);
    if (headingText) {
      capturing = headingText[1].toLowerCase() === wanted;
      continue;
    }
    if (capturing) lines.push(line);
  }
  return lines.join("\n").trim();
}
