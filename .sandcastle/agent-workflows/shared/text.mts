// Text helpers shared by the agent-workflow entrypoints.

// True when `value` is a string with at least one non-whitespace character.
// Used to validate structured output (an empty exploration comment is useless).
export function isPresent(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
