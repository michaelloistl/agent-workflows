import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveDiscord,
  threadName,
  runStartedContent,
  sliceBuildingContent,
  sliceMergedContent,
  haltSummary,
  haltEmbed,
  completeEmbed,
  sendRequest,
  createDiscordSurface,
  COLOUR_HALT,
  COLOUR_REFUSED,
  COLOUR_COMPLETE,
  THREAD_NAME_MAX,
  HALT_REASON_MAX,
  type HttpResponse,
} from "./discord.mts";

const WEBHOOK = "https://discord.com/api/webhooks/1540/tok";

// A fake transport. Records every call, answers from a queue of scripted replies,
// and defaults to a created-thread reply so the common path needs no setup.
function fakeFetch(replies: Array<HttpResponse | Error> = []) {
  const calls: Array<{ url: string; body: unknown; signal?: AbortSignal }> = [];
  const fetchImpl = async (
    url: string,
    init: { body: string; signal?: AbortSignal },
  ): Promise<HttpResponse> => {
    calls.push({ url, body: JSON.parse(init.body), signal: init.signal });
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return next ?? ok({ id: "9001", channel_id: "9001" });
  };
  return { calls, fetchImpl };
}

function ok(body: unknown): HttpResponse {
  return { status: 200, json: async () => body };
}

function status(code: number): HttpResponse {
  return { status: code, json: async () => ({}) };
}

// — resolveDiscord —
//
// THREE states, not two. `unset` and `unusable` must not collapse into each other:
// silence is right for the first and wrong for the second, since a typo'd webhook
// that says nothing lands in exactly the hole this surface exists to close.

test("resolveDiscord is ready when DISCORD_WEBHOOK_URL is a usable https URL", () => {
  assert.deepEqual(resolveDiscord({ DISCORD_WEBHOOK_URL: WEBHOOK }), {
    state: "ready",
    webhook: WEBHOOK,
  });
});

test("resolveDiscord is unset when the variable is absent or empty", () => {
  assert.equal(resolveDiscord({}).state, "unset");
  assert.equal(resolveDiscord({ DISCORD_WEBHOOK_URL: "" }).state, "unset");
});

// A pasted value that is not an https URL can only ever 404, and a 404 is the one
// response this surface must not retry — so it is rejected before it is ever sent.
test("resolveDiscord is UNUSABLE, not unset, for a value that is not an https URL", () => {
  const notUrl = resolveDiscord({ DISCORD_WEBHOOK_URL: "not a url" });
  assert.equal(notUrl.state, "unusable");
  const notHttps = resolveDiscord({ DISCORD_WEBHOOK_URL: "http://discord.com/api/webhooks/1/t" });
  assert.equal(notHttps.state, "unusable");
});

// — threadName —

test("threadName names the spec and its title", () => {
  assert.equal(
    threadName({ spec: 94, title: "A Discord run surface", repeat: false }),
    "spec #94 — A Discord run surface",
  );
});

// The thread id does not survive the process (ADR-0012), so ANY second local run of
// the same spec — a resume after a halt, but equally a real run after a dry run —
// opens a SECOND thread. The mark says "this spec has run here before", which is all
// the run log it is derived from can honestly claim; it is not a claim about resume.
test("threadName marks a repeat run", () => {
  assert.equal(
    threadName({ spec: 94, title: "A Discord run surface", repeat: true }),
    "spec #94 (re-run) — A Discord run surface",
  );
});

test("threadName stays within Discord's 100-character limit", () => {
  const name = threadName({ spec: 94, title: "x".repeat(300), repeat: true });
  assert.ok(name.length <= THREAD_NAME_MAX, `${name.length} > ${THREAD_NAME_MAX}`);
  assert.match(name, /^spec #94 \(re-run\) — x+…$/);
});

test("threadName tolerates a spec with no title", () => {
  assert.equal(threadName({ spec: 94, title: "", repeat: false }), "spec #94");
});

// — progress content —

test("runStartedContent reports the branch and the slice count", () => {
  const text = runStartedContent({ specBranch: "agent/spec-94-x", slices: 3, dryRun: false });
  assert.match(text, /run started/);
  assert.match(text, /agent\/spec-94-x/);
  assert.match(text, /3 slices/);
});

test("runStartedContent says so when the run is a dry run", () => {
  const text = runStartedContent({ specBranch: "agent/spec-94-x", slices: 1, dryRun: true });
  assert.match(text, /dry run/i);
  assert.match(text, /1 slice\b/);
});

test("sliceBuildingContent and sliceMergedContent name the slice and its position", () => {
  assert.match(sliceBuildingContent({ slice: 7, position: 2, total: 3 }), /2\/3.*#7.*building/);
  assert.match(sliceMergedContent({ slice: 7, position: 2, total: 3 }), /2\/3.*#7.*merged/);
});

// — haltSummary: the first line, truncated —
//
// Halt reasons are assembled from agent and CI output, so nothing in this repository
// bounds their contents. Discord is a third party that may retain what is posted.

test("haltSummary keeps a short single-line reason as it is", () => {
  assert.equal(haltSummary("the merge was not confirmed on GitHub"), "the merge was not confirmed on GitHub");
});

test("haltSummary keeps only the FIRST line", () => {
  assert.equal(haltSummary("the slice failed\n\nstack trace\nmore\n"), "the slice failed");
});

test("haltSummary truncates a long first line", () => {
  const summary = haltSummary("x".repeat(500));
  assert.ok(summary.length <= HALT_REASON_MAX, `${summary.length} > ${HALT_REASON_MAX}`);
  assert.ok(summary.endsWith("…"));
});

test("haltSummary falls back when the reason is blank", () => {
  assert.equal(haltSummary("   \n  "), "no reason recorded");
});

// — embeds —
//
// A refusal is not a failure (CONTEXT.md), and colour is what carries that
// distinction. `refused` arrives as a FACT from the loop, which has a dedicated
// branch for it — never re-derived from the reason's wording, which nobody is
// obliged to keep phrased any particular way.

test("haltEmbed is red, links the issue, and carries the run log", () => {
  const embed = haltEmbed({
    spec: 94,
    reason: "the merge was not confirmed on GitHub",
    refused: false,
    runLog: "/tmp/wt/spec-94.log",
    issueUrl: "https://github.com/o/r/issues/94",
  });
  assert.equal(embed.color, COLOUR_HALT);
  assert.equal(embed.url, "https://github.com/o/r/issues/94");
  assert.match(embed.title, /spec #94 halted/);
  assert.match(embed.description, /the merge was not confirmed on GitHub/);
  assert.ok(embed.fields?.some((f) => f.value.includes("/tmp/wt/spec-94.log")));
});

test("haltEmbed is AMBER when the halt was a refusal", () => {
  const embed = haltEmbed({
    spec: 94,
    reason: "the implement sequence refused at `guards`",
    refused: true,
    runLog: "/tmp/wt/spec-94.log",
    issueUrl: "https://github.com/o/r/issues/94",
  });
  assert.equal(embed.color, COLOUR_REFUSED);
  assert.match(embed.title, /refused/);
});

// The colour follows the FLAG, not the prose — the regression the fact-passing
// exists to prevent.
test("haltEmbed colours by the flag even when the wording disagrees", () => {
  const base = { spec: 94, runLog: "/l", issueUrl: "u" };
  assert.equal(haltEmbed({ ...base, reason: "the agent refused to build", refused: false }).color, COLOUR_HALT);
  assert.equal(haltEmbed({ ...base, reason: "guards declined", refused: true }).color, COLOUR_REFUSED);
});

test("completeEmbed is green and says the final PR opened", () => {
  const embed = completeEmbed({ spec: 94, merged: 3, issueUrl: "https://github.com/o/r/issues/94" });
  assert.equal(embed.color, COLOUR_COMPLETE);
  assert.match(embed.title, /spec #94 complete/);
  assert.match(embed.description, /final PR opened/);
  assert.match(embed.description, /3 slices/);
});

// — sendRequest —
//
// `wait=true` on EVERY send: the default does not return an error for a message that
// was not saved, which is silent loss in a surface whose whole value is being trusted.

test("sendRequest posts JSON to the webhook with wait=true", () => {
  const { url, init } = sendRequest(WEBHOOK, null, { content: "hi" });
  assert.equal(url, `${WEBHOOK}?wait=true`);
  assert.equal(init.method, "POST");
  assert.equal(init.headers["content-type"], "application/json");
  // `allowed_mentions` is added HERE rather than by each payload builder, so no send
  // can be added later that forgets it.
  assert.deepEqual(JSON.parse(init.body), { content: "hi", allowed_mentions: { parse: [] } });
});

test("sendRequest addresses an existing thread with thread_id", () => {
  const { url } = sendRequest(WEBHOOK, "9001", { content: "hi" });
  assert.equal(url, `${WEBHOOK}?wait=true&thread_id=9001`);
});

test("sendRequest appends to a webhook URL that already has a query", () => {
  const { url } = sendRequest(`${WEBHOOK}?x=1`, null, { content: "hi" });
  assert.equal(url, `${WEBHOOK}?x=1&wait=true`);
});

// — the surface, unconfigured —

test("with no webhook the surface is inactive, silent, and sends nothing", async () => {
  const { calls, fetchImpl } = fakeFetch();
  const surface = createDiscordSurface({}, fetchImpl);
  assert.equal(surface.active, false);
  // Silent means SILENT: an unconfigured surface contributes no preview line at all,
  // because most consuming repos will never configure one.
  assert.equal(await surface.openThread({ spec: 94, title: "t", specBranch: "b", slices: 1, dryRun: false, repeat: false }), null);
  await surface.noteSliceBuilding({ slice: 1, position: 1, total: 1 });
  await surface.noteSliceMerged({ slice: 1, position: 1, total: 1 });
  await surface.notifyHalt({ spec: 94, reason: "x", refused: false, runLog: "/l", issueUrl: "u" });
  await surface.notifyComplete({ spec: 94, merged: 1, issueUrl: "u" });
  assert.deepEqual(calls, []);
});

// A webhook somebody MEANT to configure and got wrong is not silent — that is the
// hole the two loud exceptions exist to close, and a typo falls straight into it.
test("a misconfigured webhook says so in the preview and sends nothing", async () => {
  const { calls, fetchImpl } = fakeFetch();
  const surface = createDiscordSurface(
    { DISCORD_WEBHOOK_URL: "http://discord.com/api/webhooks/1/t" },
    fetchImpl,
  );
  const line = await surface.openThread({ spec: 94, title: "t", specBranch: "b", slices: 1, dryRun: false, repeat: false });
  assert.match(line ?? "", /^off \(DISCORD_WEBHOOK_URL is not an https URL\)$/);
  assert.equal(surface.active, false);
  await surface.notifyHalt({ spec: 94, reason: "x", refused: false, runLog: "/l", issueUrl: "u" });
  assert.deepEqual(calls, []);
});

// — the surface, opening a thread —

test("openThread creates the forum thread and reports it for the preview", async () => {
  const { calls, fetchImpl } = fakeFetch();
  const surface = createDiscordSurface({ DISCORD_WEBHOOK_URL: WEBHOOK }, fetchImpl);
  const line = await surface.openThread({
    spec: 94,
    title: "A Discord run surface",
    specBranch: "agent/spec-94-x",
    slices: 3,
    dryRun: false,
    repeat: false,
  });
  assert.equal(line, "spec #94 thread created");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${WEBHOOK}?wait=true`);
  const body = calls[0].body as { thread_name: string; content: string };
  assert.equal(body.thread_name, "spec #94 — A Discord run surface");
  assert.match(body.content, /run started/);
});

// The returned message's `id` IS the new thread's id — verified by probe, not assumed
// (ADR-0012). Every later send in the run is addressed with it.
test("later sends are addressed to the thread the create returned", async () => {
  const { calls, fetchImpl } = fakeFetch([ok({ id: "9001", channel_id: "9001" })]);
  const surface = createDiscordSurface({ DISCORD_WEBHOOK_URL: WEBHOOK }, fetchImpl);
  await surface.openThread({ spec: 94, title: "t", specBranch: "b", slices: 1, dryRun: false, repeat: false });
  await surface.noteSliceBuilding({ slice: 7, position: 1, total: 1 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, `${WEBHOOK}?wait=true&thread_id=9001`);
});

// A forum channel accepts no message outside a thread, so a failed create silences
// the WHOLE run — including the halt notification the surface exists to deliver.
// That is the first of the two loud exceptions to silence.
test("a failed create disables the surface for the run and says so in the preview", async () => {
  const { calls, fetchImpl } = fakeFetch([status(400), status(400)]);
  const surface = createDiscordSurface({ DISCORD_WEBHOOK_URL: WEBHOOK }, fetchImpl);
  const line = await surface.openThread({ spec: 94, title: "t", specBranch: "b", slices: 1, dryRun: false, repeat: false });
  // A bare status phrase — the preview owns its own label column.
  assert.match(line ?? "", /^off \(/);
  assert.match(line ?? "", /forum channel/);
  assert.equal(surface.active, false);
  await surface.notifyHalt({ spec: 94, reason: "x", refused: false, runLog: "/l", issueUrl: "u" });
  assert.equal(calls.length, 2, "the create was tried twice and nothing was sent after");
});

// A REFUSED create — Discord answered, and the answer was not a success — demonstrably
// created nothing, so it is the one create failure that may safely be tried again.
test("a refused create is retried exactly once", async () => {
  const { calls, fetchImpl } = fakeFetch([status(500), ok({ id: "9001" })]);
  const surface = createDiscordSurface({ DISCORD_WEBHOOK_URL: WEBHOOK }, fetchImpl);
  const line = await surface.openThread({ spec: 94, title: "t", specBranch: "b", slices: 1, dryRun: false, repeat: false });
  assert.equal(line, "spec #94 thread created");
  assert.equal(calls.length, 2);
});

// An UNANSWERED create — a 2s timeout, a severed network — may have landed anyway:
// Discord may have created the thread and lost the reply inside the budget. Since
// `thread_name` is not an idempotency key (verified by probe, ADR-0012), retrying
// would leave a duplicate forum post, so it is never retried. The preview says which
// case it was, because "it may exist" is a different thing to go and check than "the
// channel is the wrong type".
test("an UNANSWERED create is not retried, and the preview says it may exist", async () => {
  const { calls, fetchImpl } = fakeFetch([new Error("ETIMEDOUT")]);
  const surface = createDiscordSurface({ DISCORD_WEBHOOK_URL: WEBHOOK }, fetchImpl);
  const line = await surface.openThread({ spec: 94, title: "t", specBranch: "b", slices: 1, dryRun: false, repeat: false });
  assert.equal(calls.length, 1);
  assert.match(line ?? "", /^off \(/);
  assert.match(line ?? "", /may/);
  assert.equal(surface.active, false);
});

// Discord documents that a 404 must NOT be retried, on pain of an IP-level block at
// 10,000 invalid requests in ten minutes. It is also the deleted-or-rotated-webhook
// case, which would otherwise fail silently forever.
// ADR-0012 specifies stderr for the 404 exception, so it prints here too even though
// the preview also names the cause — the two go to different streams, and a developer
// who has redirected stdout still needs to see why the surface went quiet.
test("a 404 on create is NOT retried, and still warns on stderr", async () => {
  const warnings: string[] = [];
  const { calls, fetchImpl } = fakeFetch([status(404)]);
  const surface = createDiscordSurface({ DISCORD_WEBHOOK_URL: WEBHOOK }, fetchImpl, (l) => warnings.push(l));
  const line = await surface.openThread({ spec: 94, title: "t", specBranch: "b", slices: 1, dryRun: false, repeat: false });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /404/);
  assert.equal(calls.length, 1);
  assert.match(line ?? "", /404|no longer exists|deleted/i);
});

// — the surface, once open —

test("halt and complete post embeds into the thread", async () => {
  const { calls, fetchImpl } = fakeFetch();
  const surface = createDiscordSurface({ DISCORD_WEBHOOK_URL: WEBHOOK }, fetchImpl);
  await surface.openThread({ spec: 94, title: "t", specBranch: "b", slices: 1, dryRun: false, repeat: false });
  await surface.notifyHalt({ spec: 94, reason: "boom", refused: false, runLog: "/l", issueUrl: "u" });
  await surface.notifyComplete({ spec: 94, merged: 1, issueUrl: "u" });
  const halt = calls[1].body as { embeds: Array<{ color: number }> };
  const done = calls[2].body as { embeds: Array<{ color: number }> };
  assert.equal(halt.embeds[0].color, COLOUR_HALT);
  assert.equal(done.embeds[0].color, COLOUR_COMPLETE);
});

// Halt reasons come from agent and CI output. A reason containing `@everyone` must
// not ping a channel, so every send suppresses mention parsing.
test("every send suppresses mention parsing", async () => {
  const { calls, fetchImpl } = fakeFetch();
  const surface = createDiscordSurface({ DISCORD_WEBHOOK_URL: WEBHOOK }, fetchImpl);
  await surface.openThread({ spec: 94, title: "t", specBranch: "b", slices: 1, dryRun: false, repeat: false });
  await surface.notifyHalt({ spec: 94, reason: "@everyone boom", refused: false, runLog: "/l", issueUrl: "u" });
  for (const call of calls) {
    assert.deepEqual((call.body as { allowed_mentions: unknown }).allowed_mentions, { parse: [] });
  }
});

// Rule 2, the one every emit must obey: never fail or delay a run.
test("a failing send after the thread is open never propagates", async () => {
  const { fetchImpl } = fakeFetch([ok({ id: "9001" }), new Error("network down"), status(500)]);
  const surface = createDiscordSurface({ DISCORD_WEBHOOK_URL: WEBHOOK }, fetchImpl);
  await surface.openThread({ spec: 94, title: "t", specBranch: "b", slices: 1, dryRun: false, repeat: false });
  await assert.doesNotReject(() => surface.noteSliceBuilding({ slice: 1, position: 1, total: 1 }));
  await assert.doesNotReject(() => surface.notifyHalt({ spec: 94, reason: "x", refused: false, runLog: "/l", issueUrl: "u" }));
});

// The second loud exception. A 404 mid-run means the webhook was deleted or rotated;
// every later send would fail silently forever, so the surface stands down and says
// so exactly once.
test("a 404 mid-run disables the surface for the process and warns once", async () => {
  const warnings: string[] = [];
  const { calls, fetchImpl } = fakeFetch([ok({ id: "9001" }), status(404)]);
  const surface = createDiscordSurface({ DISCORD_WEBHOOK_URL: WEBHOOK }, fetchImpl, (line) => warnings.push(line));
  await surface.openThread({ spec: 94, title: "t", specBranch: "b", slices: 1, dryRun: false, repeat: false });
  await surface.noteSliceBuilding({ slice: 1, position: 1, total: 1 });
  await surface.noteSliceMerged({ slice: 1, position: 1, total: 1 });
  await surface.notifyHalt({ spec: 94, reason: "x", refused: false, runLog: "/l", issueUrl: "u" });
  assert.equal(calls.length, 2, "nothing was sent after the 404");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /404/);
  assert.equal(surface.active, false);
});

// An ordinary failure is NOT loud — that is rule 1. Only the surface's own death is.
test("a non-404 failure mid-run warns about nothing and keeps the surface up", async () => {
  const warnings: string[] = [];
  const { calls, fetchImpl } = fakeFetch([ok({ id: "9001" }), status(500)]);
  const surface = createDiscordSurface({ DISCORD_WEBHOOK_URL: WEBHOOK }, fetchImpl, (line) => warnings.push(line));
  await surface.openThread({ spec: 94, title: "t", specBranch: "b", slices: 1, dryRun: false, repeat: false });
  await surface.noteSliceBuilding({ slice: 1, position: 1, total: 1 });
  await surface.noteSliceMerged({ slice: 1, position: 1, total: 1 });
  assert.deepEqual(warnings, []);
  assert.equal(calls.length, 3);
  assert.equal(surface.active, true);
});

// A create that returns 200 but no usable id is a create that did not happen, and
// must be reported like one rather than leaving the run posting to nowhere.
test("a create with no id in the reply is treated as a failure, and not retried", async () => {
  const { calls, fetchImpl } = fakeFetch([ok({}), ok({ id: "9001" })]);
  const surface = createDiscordSurface({ DISCORD_WEBHOOK_URL: WEBHOOK }, fetchImpl);
  const line = await surface.openThread({ spec: 94, title: "t", specBranch: "b", slices: 1, dryRun: false, repeat: false });
  assert.match(line ?? "", /off \(/);
  assert.equal(surface.active, false);
  // A 2xx means Discord SAVED the message, so the thread exists even though its id
  // did not come back readable. Trying again would post a second one.
  assert.equal(calls.length, 1);
});

// Rule 2 rests entirely on this. The surface cannot claim Herdr's flat "no delay"
// because it must await its sends, so "bounded by 2s" is what makes "never delays a
// run" true — and an unasserted bound is one deleted argument away from unbounded.
test("every send carries an abort signal, so no send is unbounded", async () => {
  const { calls, fetchImpl } = fakeFetch();
  const surface = createDiscordSurface({ DISCORD_WEBHOOK_URL: WEBHOOK }, fetchImpl);
  await surface.openThread({ spec: 94, title: "t", specBranch: "b", slices: 1, dryRun: false, repeat: false });
  await surface.noteSliceBuilding({ slice: 1, position: 1, total: 1 });
  await surface.notifyComplete({ spec: 94, merged: 1, issueUrl: "u" });
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.ok(call.signal instanceof AbortSignal, "no abort signal on a send");
    assert.equal(call.signal?.aborted, false);
  }
});

// Nothing may be emitted before the thread exists — a forum channel would reject it,
// and a caller that got the ordering wrong should not silently post into the void.
test("emits before openThread send nothing", async () => {
  const { calls, fetchImpl } = fakeFetch();
  const surface = createDiscordSurface({ DISCORD_WEBHOOK_URL: WEBHOOK }, fetchImpl);
  await surface.noteSliceBuilding({ slice: 1, position: 1, total: 1 });
  await surface.notifyComplete({ spec: 94, merged: 1, issueUrl: "u" });
  assert.deepEqual(calls, []);
});
