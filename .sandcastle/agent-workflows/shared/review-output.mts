import { standardSchema, type StandardSchema } from "./json.mts";
import { isPresent } from "./text.mts";

// The structured review-output types shared by the PR-review entrypoint. A
// review is a top-level summary plus zero or more inline comments keyed to a
// file + line, which the workflow posts as a single GitHub review via `gh`.

// One inline comment, keyed to a file path (repo-root-relative) and a line in
// the new version of the file (the side the GitHub reviews API defaults to).
export interface ReviewInlineComment {
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

// A complete review: a non-empty summary and any inline comments.
export interface ReviewOutput {
  readonly summary: string;
  readonly comments: ReadonlyArray<ReviewInlineComment>;
}

// The request body the GitHub reviews API (`POST /pulls/{n}/reviews`) accepts.
// `gh api --input` posts this verbatim.
export interface ReviewPayload {
  readonly body: string;
  readonly event: "COMMENT";
  readonly comments: ReadonlyArray<ReviewInlineComment>;
}

// Standard Schema the extraction pass's JSON is validated against: a non-empty
// summary and a (possibly empty) array of well-shaped inline comments.
export const reviewOutputSchema: StandardSchema<ReviewOutput> = standardSchema(
  (value) => {
    if (typeof value !== "object" || value === null) {
      return { issues: [{ message: "expected a JSON object" }] };
    }
    const record = value as Record<string, unknown>;
    if (!isPresent(record.summary)) {
      return { issues: [{ message: "`summary` must be a non-empty string" }] };
    }
    if (!Array.isArray(record.comments)) {
      return {
        issues: [{ message: "`comments` must be an array (use [] for none)" }],
      };
    }
    // Skip malformed inline entries rather than failing the whole review: the
    // summary is still worth posting, and a single off-shape comment from the
    // model should not waste the run. `postableComments` applies the same shape
    // check at post time.
    const comments: ReviewInlineComment[] = [];
    for (const entry of record.comments) {
      if (typeof entry !== "object" || entry === null) continue;
      const comment = entry as Record<string, unknown>;
      if (
        !isPresent(comment.path) ||
        !isPresent(comment.body) ||
        typeof comment.line !== "number"
      ) {
        continue;
      }
      comments.push({ path: comment.path, line: comment.line, body: comment.body });
    }
    return { value: { summary: record.summary, comments } };
  },
);

// Keep only the inline comments the GitHub reviews API can accept: a real path,
// a positive integer line, and a non-empty body. Malformed entries are dropped
// rather than failing the whole review post.
export function postableComments(
  comments: ReadonlyArray<ReviewInlineComment>,
): ReviewInlineComment[] {
  return comments.filter(
    (comment) =>
      isPresent(comment.path) &&
      isPresent(comment.body) &&
      Number.isInteger(comment.line) &&
      comment.line > 0,
  );
}

// Build the reviews-API request body from a validated review output.
export function reviewPayload(output: ReviewOutput): ReviewPayload {
  return {
    body: output.summary,
    event: "COMMENT",
    comments: postableComments(output.comments),
  };
}
