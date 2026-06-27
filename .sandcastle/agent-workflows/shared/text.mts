// Text helpers shared by the agent-workflow entrypoints.

// True when `value` is a string with at least one non-whitespace character.
// Used to validate structured output (an empty exploration comment is useless).
export function isPresent(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// A branch-name slug from an issue/PRD title: lowercase, non-alphanumerics folded
// to single hyphens, trimmed, capped at 40 chars. Shared by `implement`'s
// tracer-bullet branch (`agent/issue-<n>-<slug>`) and the orchestrator's PRD
// branch (`agent/prd-<n>-<slug>`).
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
