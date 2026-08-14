import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATTENTION_PERCENT,
  CRITICAL_PERCENT,
  formatQuota,
  parseQuota,
  throttled,
  withQuota,
  type Quota,
} from "./quota.mts";

// The real shape of `claude --print --output-format json "/usage"`, trimmed to the fields
// this parses. Captured from Claude Code 2.1.232 — the prose in `result` is verbatim,
// because it is the thing under test: this module reads rendered English, so a fixture
// that tidies it up would test a format nobody emits.
const RESULT = [
  "You are currently using your subscription to power your Claude Code usage",
  "",
  "Current session: 6% used · resets Aug 14 at 4:19pm (Atlantic/Madeira)",
  "Current week (all models): 37% used · resets Aug 15 at 5:59am (Atlantic/Madeira)",
  "Current week (Fable): 0% used",
  "",
  "What's contributing to your limits usage?",
  "Last 7d · 4848 requests · 48 sessions",
  "  Top skills: /implement 16%, /prototype 3%",
].join("\n");

function envelope(result: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ is_error: false, type: "result", subtype: "success", result, ...extra });
}

test("reads both named windows, their percentages and their resets", () => {
  const quota = parseQuota(envelope(RESULT));
  assert.ok(quota);
  assert.equal(quota.session.percent, 6);
  assert.equal(quota.week.percent, 37);
  // The zone is dropped and "at" collapses to a space: redundant on the machine that
  // rendered it, and the line is a column rather than a sentence.
  assert.equal(quota.session.resets, "Aug 14 4:19pm");
  assert.equal(quota.week.resets, "Aug 15 5:59am");
});

test("carries per-model windows separately from the aggregate row", () => {
  const quota = parseQuota(envelope(RESULT));
  assert.ok(quota);
  // "all models" is the aggregate, already held as `week` — it must not also appear as a
  // model window, or the line would print the same number twice.
  assert.deepEqual(
    quota.models.map((w) => w.label),
    ["Fable"],
  );
  // The per-model line carries no reset at all, which is a shape rather than a failure.
  assert.equal(quota.models[0]!.resets, null);
});

test("reads several model windows, whatever they are named", () => {
  const text = [
    "Current session: 1% used · resets Aug 14 at 4:19pm (Atlantic/Madeira)",
    "Current week (all models): 2% used · resets Aug 15 at 5:59am (Atlantic/Madeira)",
    "Current week (Opus): 44% used",
    "Current week (Sonnet only): 12% used",
  ].join("\n");
  const quota = parseQuota(envelope(text));
  assert.ok(quota);
  assert.deepEqual(
    quota.models.map((w) => [w.label, w.percent]),
    [
      ["Opus", 44],
      ["Sonnet only", 12],
    ],
  );
});

test("accepts a fractional percentage without reading it as a parse failure", () => {
  const text = [
    "Current session: 6.4% used · resets Aug 14 at 4:19pm",
    "Current week (all models): 37.5% used · resets Aug 15 at 5:59am",
  ].join("\n");
  const quota = parseQuota(envelope(text));
  assert.ok(quota);
  assert.equal(quota.session.percent, 6);
  assert.equal(quota.week.percent, 38);
});

// Every failure resolves to `null` — never a throw the caller has to catch a second time,
// and never a half-read block. A session bar with no weekly bar reads as "the week is
// fine", which is the one wrong impression this must not leave.
test("refuses anything that is not recognisably the usage command's output", () => {
  const sessionOnly = "Current session: 6% used · resets Aug 14 at 4:19pm";
  const weekOnly = "Current week (all models): 37% used · resets Aug 15 at 5:59am";
  assert.equal(parseQuota(envelope(sessionOnly)), null, "session alone is a partial read");
  assert.equal(parseQuota(envelope(weekOnly)), null, "week alone is a partial read");
  assert.equal(parseQuota("not json at all"), null);
  assert.equal(parseQuota(""), null);
  assert.equal(parseQuota("null"), null);
  assert.equal(parseQuota(JSON.stringify({ result: 42 })), null, "result must be prose");
  assert.equal(parseQuota(JSON.stringify({ result: "" })), null);
  // Auth that has no subscription windows at all (API key, Bedrock, Vertex) renders no
  // window lines, so the same refusal covers it.
  assert.equal(parseQuota(envelope("You are currently using an API key")), null);
  // The command reports failure in-band at exit 0, so the flag is checked rather than
  // trusted to have surfaced as a throw upstream.
  assert.equal(parseQuota(envelope(RESULT, { is_error: true })), null);
});

// Every percentage carries the word `used`, because the figure is CONSUMPTION while the
// feature is its complement: a bare `week 37%` beside a line labelled quota is read as
// "37% left" as readily as "37% gone", and it is the second reading the colour ramp and
// every decision made from the line depend on.
test("renders one compact line, stating each window as the share used", () => {
  const quota = parseQuota(envelope(RESULT));
  assert.ok(quota);
  assert.equal(
    formatQuota(quota),
    "quota · session 6% used (resets Aug 14 4:19pm) · week 37% used (resets Aug 15 5:59am)",
  );
});

test("keeps a model window once it has been used", () => {
  const quota = parseQuota(envelope(RESULT.replace("(Fable): 0%", "(Fable): 12%")));
  assert.ok(quota);
  assert.match(formatQuota(quota), /· Fable 12% used$/);
});

test("paints each window on its own threshold, and only when asked", () => {
  const at = (percent: number): Quota => ({
    session: { label: "session", percent, resets: null },
    week: { label: "week", percent: 0, resets: null },
    models: [],
  });
  const sessionOf = (percent: number) => formatQuota(at(percent), { colour: true }).split(" · ")[1]!;

  // Dimmed below the attention threshold: headroom that is fine is what nobody needs to
  // scan for, so it recedes exactly as `pending` does in the tree.
  assert.match(sessionOf(ATTENTION_PERCENT - 1), /^\x1b\[2m/);
  assert.match(sessionOf(ATTENTION_PERCENT), /^\x1b\[33m/);
  assert.match(sessionOf(CRITICAL_PERCENT - 1), /^\x1b\[33m/);
  assert.match(sessionOf(CRITICAL_PERCENT), /^\x1b\[1;31m/);
  assert.match(sessionOf(100), /^\x1b\[1;31m/);

  // Off by default, and off means no escapes at all rather than escapes a pipe has to
  // strip — the same rule the tree renderer follows.
  assert.ok(!formatQuota(at(99)).includes("\x1b"));
});

test("leads the view, and leaves it untouched when there is no line", () => {
  const body = "owner/repo — 1 spec in flight\n\n#12  Title  building";
  assert.equal(withQuota(body, null), body, "a failed read costs the view nothing");
  assert.equal(withQuota(body, "quota · session 6%"), `quota · session 6%\n\n${body}`);
});

// The read costs ~1.4s of wall clock against a 5s default tick, so the watch loop reuses
// one rather than blocking a quarter of every redraw on a number that moves in fractions
// of a percent per minute.
test("throttling reads once per window and reuses the answer in between", () => {
  let reads = 0;
  let at = 0;
  const read = throttled(() => `read ${++reads}`, 30_000, () => at);

  assert.equal(read(), "read 1", "the first call always reads");
  at = 29_999;
  assert.equal(read(), "read 1");
  assert.equal(reads, 1, "nothing inside the window costs a subprocess");

  at = 30_000;
  assert.equal(read(), "read 2", "the window elapsing reads again");
  at = 59_999;
  assert.equal(read(), "read 2");
  assert.equal(reads, 2);
});

test("throttling costs one read per window when every read fails", () => {
  let reads = 0;
  let at = 0;
  // A machine with no `claude` on its PATH resolves to `null` every time, and must pay for
  // discovering that once per window rather than on every redraw. With nothing good ever
  // held, there is nothing to carry either: the view simply has no line.
  const read = throttled(
    () => {
      reads++;
      return null;
    },
    30_000,
    () => at,
  );

  assert.equal(read(), null);
  at = 10_000;
  assert.equal(read(), null);
  assert.equal(reads, 1);
  at = 30_000;
  assert.equal(read(), null);
  assert.equal(reads, 2);
});

// A blip — one 4s timeout, one wedged startup — must not blank the line, because dropping
// it shifts the whole tree up two rows on the surface where the number is being watched
// hardest. The last good read is carried across exactly ONE failed window: long enough to
// absorb a blip, short enough that a CLI which has genuinely stopped answering cannot leave
// a stale percentage on screen all night.
test("throttling carries the last good read across a single failed window", () => {
  let at = 0;
  let answer: string | null = "quota · session 6% used";
  const read = throttled(() => answer, 30_000, () => at);

  assert.equal(read(), "quota · session 6% used");

  answer = null;
  at = 30_000;
  assert.equal(read(), "quota · session 6% used", "one failure is absorbed, not shown");

  at = 60_000;
  assert.equal(read(), null, "a second consecutive failure drops the line");
});

test("throttling starts carrying again once a read succeeds", () => {
  let at = 0;
  let answer: string | null = "first";
  const read = throttled(() => answer, 30_000, () => at);

  assert.equal(read(), "first");
  answer = null;
  at = 30_000;
  assert.equal(read(), "first");

  // Recovery resets the allowance rather than leaving it spent: the next blip after a
  // good read is a first failure again.
  answer = "second";
  at = 60_000;
  assert.equal(read(), "second");
  answer = null;
  at = 90_000;
  assert.equal(read(), "second");
  at = 120_000;
  assert.equal(read(), null);
});
