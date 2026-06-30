import { standardSchema, type StandardSchema } from "./json.mts";
import { isPresent } from "./text.mts";

// The structured output shape for the `agent:implement` PR workflow. After the
// work pass pushes its fixes, it hands back one reply per review comment it
// addressed plus a short summary, which the workflow posts via `gh`. This is the
// implement-pr counterpart to ./review-output.mts (which the read-only review
// workflow uses): review produces NEW inline comments; implement-pr produces
// REPLIES to existing ones, keyed to the comment's numeric id.

// One reply, keyed to the id of the review comment it addresses (from the
// comments JSON gathered by pr-context). The body is posted as a threaded reply.
export interface CommentReply {
  readonly commentId: number;
  readonly body: string;
}

// A complete implement-pr result: a non-empty summary of what was pushed and any
// per-comment replies.
export interface ReplyOutput {
  readonly summary: string;
  readonly replies: ReadonlyArray<CommentReply>;
}

// Standard Schema the extraction pass's JSON is validated against: a non-empty
// summary and a (possibly empty) array of well-shaped replies.
export const replyOutputSchema: StandardSchema<ReplyOutput> = standardSchema(
  (value) => {
    if (typeof value !== "object" || value === null) {
      return { issues: [{ message: "expected a JSON object" }] };
    }
    const record = value as Record<string, unknown>;
    if (!isPresent(record.summary)) {
      return { issues: [{ message: "`summary` must be a non-empty string" }] };
    }
    if (!Array.isArray(record.replies)) {
      return {
        issues: [{ message: "`replies` must be an array (use [] for none)" }],
      };
    }
    // Skip malformed reply entries rather than failing the whole run: the fixes
    // were already committed and the summary is worth posting, so a single
    // off-shape reply from the model should not waste the push.
    const replies: CommentReply[] = [];
    for (const entry of record.replies) {
      if (typeof entry !== "object" || entry === null) continue;
      const reply = entry as Record<string, unknown>;
      if (
        typeof reply.commentId !== "number" ||
        !Number.isInteger(reply.commentId) ||
        reply.commentId <= 0 ||
        !isPresent(reply.body)
      ) {
        continue;
      }
      replies.push({ commentId: reply.commentId, body: reply.body });
    }
    return { value: { summary: record.summary, replies } };
  },
);
