// The optional Discord run surface for unsupervised local spec runs (ADR-0012).
// ADR-0011 made a bare `implement-spec <n>` build a whole spec without stopping, and
// recorded the consequence: the assumption that a human sees a halt is now false by
// default. A two-hour run that stops at 2am has a perfect RECORD — the run log, the
// progress comment — and no REACH. This is the reach: one forum thread per run,
// carrying five events, pushed into a channel the developer already has on a phone.
//
// It is the second *run surface*, and it inherits Herdr's three rules, with the second
// stated more precisely than Herdr needs it:
//   1. STRICTLY best-effort — with no `DISCORD_WEBHOOK_URL` it is a silent no-op that
//      warns about nothing and contributes no preview line at all. Most consuming
//      repos will never configure one, and they must not be nagged.
//   2. NEVER fail a run, and never delay one UNBOUNDEDLY — every emit swallows
//      everything, and every send is bounded by a 2s timeout and never retried, with
//      one exception: the initial thread create, which is tried twice when Discord
//      answers and refuses, so kickoff can spend up to ~4s before the preview prints.
//      Herdr can claim a flat "no delay" because it spawns and ignores the result;
//      this surface cannot, because it must await (see `sendRequest` on `wait=true`),
//      so the bound is what does the work. A send measured at about 0.4s sits against
//      a slice measured in minutes.
//   3. No required dependency — a webhook URL and `fetch`. No bot, no token, no
//      gateway connection held open for the length of the run.
//
// There are exactly TWO loud exceptions to rule 1, and both report the SURFACE's own
// health rather than the run's, because a surface that has died mid-run is otherwise
// indistinguishable from one that was never configured:
//   - a failed thread create, which is stated in the preview (a forum channel accepts
//     no message outside a thread, so this silences the entire run);
//   - an HTTP 404, which means the webhook was deleted or rotated and every later
//     send would fail silently forever. It prints one line and stands down.
//
// Kept pure where it matters: detection, the thread name, every message body, and the
// request each send issues are unit-testable functions; only the injected `fetch`
// touches the network.

// The environment variable holding the incoming webhook. It lives in
// `.sandcastle/.env` beside `CLAUDE_CODE_OAUTH_TOKEN` — gitignored, because it is a
// credential — and reaches this process via `loadSandcastleEnv` (sandcastle itself
// resolves that file into the AGENT's environment only, never the sequencer's).
const DISCORD_WEBHOOK_ENV = "DISCORD_WEBHOOK_URL";

// Every send is bounded. Generous rather than tight — a measured send round-trips in
// about 0.4s — because the budget exists to bound a network that has stopped
// answering, not to bound a normal send.
export const SEND_TIMEOUT_MS = 2000;

// Discord's own limit on `thread_name`.
export const THREAD_NAME_MAX = 100;

// How much of a halt reason travels. Halt reasons are assembled from agent and CI
// output, so their contents are bounded by nothing in this repository, and Discord is
// a third party that may retain what is posted after it is deleted. The message's job
// is to make the developer LOOK; the run log and the issue comment remain the record.
export const HALT_REASON_MAX = 200;

// Colour is what makes an unread channel scannable, so the two terminal events carry
// it: red for a halt, amber where that halt's reason is a refusal (a refusal is not a
// failure), green for a completion.
export const COLOUR_HALT = 0xd83c3e;
export const COLOUR_REFUSED = 0xe6a817;
export const COLOUR_COMPLETE = 0x2ecc71;

// What the environment says about the surface. THREE states, not two, and the third
// is the point: `unset` is the ordinary case and stays silent, while `unusable` is a
// surface somebody meant to configure and misconfigured. Collapsing those two would
// put a typo'd webhook into exactly the hole this design exists to close — a surface
// that is not working, looking identical to one that was never asked for.
export type DiscordResolution =
  | { readonly state: "unset" }
  | { readonly state: "unusable"; readonly detail: string }
  | { readonly state: "ready"; readonly webhook: string };

// Resolve the webhook from the environment — the single point that decides whether
// anything is sent at all. A value that is not an https URL is rejected here rather
// than sent, because the only answer it could ever get is a 404, and a 404 is the one
// response this surface must not retry.
export function resolveDiscord(env: NodeJS.ProcessEnv): DiscordResolution {
  const webhook = env[DISCORD_WEBHOOK_ENV];
  if (!webhook) return { state: "unset" };
  let url: URL;
  try {
    url = new URL(webhook);
  } catch {
    return { state: "unusable", detail: `${DISCORD_WEBHOOK_ENV} is not a URL` };
  }
  if (url.protocol !== "https:") {
    return { state: "unusable", detail: `${DISCORD_WEBHOOK_ENV} is not an https URL` };
  }
  return { state: "ready", webhook };
}

// The forum thread's name. One thread per run, so it must read at a glance in a
// channel list: the spec number first, then its title. A REPEAT run is marked, because
// the thread id is the one thing that does not survive the process (resume derives
// from the tracker and the branches alone), so a second local run of the same spec
// opens a SECOND thread. `repeat`, not `resumed`: the signal behind it is that this
// spec has run on this machine before, which a resume satisfies but so does a real run
// after a dry run — and labelling that one `(resumed)` would be a claim about resume
// that nothing checked.
export function threadName(o: { spec: number; title: string; repeat: boolean }): string {
  const head = `spec #${o.spec}${o.repeat ? " (re-run)" : ""}`;
  const full = o.title ? `${head} — ${o.title}` : head;
  return truncate(full, THREAD_NAME_MAX);
}

// The thread's opening message: what this run is about to do, so the thread is
// readable on its own without scrolling back to the terminal it came from.
export function runStartedContent(o: {
  specBranch: string;
  slices: number;
  dryRun: boolean;
}): string {
  const mode = o.dryRun ? " · dry run (nothing is merged)" : "";
  return `**run started** · \`${o.specBranch}\` · ${plural(o.slices, "slice")}${mode}`;
}

// The two progress events. Position before slice number: `2/3` is the number the
// developer actually wants from a glance at a phone.
export function sliceBuildingContent(o: { slice: number; position: number; total: number }): string {
  return `${o.position}/${o.total} · #${o.slice} building…`;
}

export function sliceMergedContent(o: { slice: number; position: number; total: number }): string {
  return `${o.position}/${o.total} · #${o.slice} merged ✅`;
}

// The first line of a halt reason, truncated. Both halves matter: the first line
// because a reason may carry a stack trace or CI output behind it, and the truncation
// because even one line is not bounded.
export function haltSummary(reason: string): string {
  const first = (reason.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
  return first ? truncate(first, HALT_REASON_MAX) : "no reason recorded";
}

// A Discord embed, narrowed to the fields this surface uses.
export interface Embed {
  readonly title: string;
  readonly description: string;
  readonly color: number;
  readonly url?: string;
  readonly fields?: ReadonlyArray<{ name: string; value: string }>;
}

// The halt embed. The title links the spec issue, so the one tap a phone affords
// lands somewhere useful, and the run log's path travels for the developer who is
// back at the machine.
//
// `refused` is passed IN as a fact, never re-derived from the reason's wording. The
// loop already knows — it has a dedicated branch for a sequence that declined — and a
// colour that depended on matching English prose would silently turn amber into red
// the first time somebody rephrased a halt message.
export function haltEmbed(o: {
  spec: number;
  reason: string;
  refused: boolean;
  runLog: string;
  issueUrl: string;
}): Embed {
  return {
    title: `spec #${o.spec} ${o.refused ? "refused" : "halted"}`,
    url: o.issueUrl,
    description: haltSummary(o.reason),
    color: o.refused ? COLOUR_REFUSED : COLOUR_HALT,
    fields: [{ name: "run log", value: `\`${o.runLog}\`` }],
  };
}

// The completion embed — the only green thing the surface ever posts.
export function completeEmbed(o: { spec: number; merged: number; issueUrl: string }): Embed {
  return {
    title: `spec #${o.spec} complete`,
    url: o.issueUrl,
    description: `final PR opened · ${plural(o.merged, "slice")} merged`,
    color: COLOUR_COMPLETE,
  };
}

// The init a send issues. Narrow on purpose: the surface builds it, the injected
// transport executes it, and a test asserts it without a network.
export interface SendInit {
  readonly method: "POST";
  readonly headers: Record<string, string>;
  readonly body: string;
}

// The request for one send. `wait=true` on EVERY send, without exception: the default
// "does not return an error" for a message that was not saved, which is silent loss
// in a surface whose entire value is that it is trusted. `thread_id` addresses the
// run's thread once it exists; its absence (with `thread_name` in the payload) is what
// CREATES that thread.
//
// `allowed_mentions` is stamped here rather than by each payload builder, so a send
// added later cannot forget it — halt reasons come from agent and CI output, and a
// reason containing `@everyone` must not ping a channel.
export function sendRequest(
  webhook: string,
  threadId: string | null,
  payload: Record<string, unknown>,
): { url: string; init: SendInit } {
  const sep = webhook.includes("?") ? "&" : "?";
  const url = `${webhook}${sep}wait=true${threadId ? `&thread_id=${threadId}` : ""}`;
  return {
    url,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, allowed_mentions: { parse: [] } }),
    },
  };
}

// What one send did. THREE cases rather than a bare success/failure, and the third is
// the load-bearing one: a request that was never answered may still have been ACTED
// ON — Discord may have created the thread and lost the reply inside the 2s budget —
// so it is the failure a create must not retry, `thread_name` being no idempotency key
// (verified by probe, ADR-0012). A REFUSED send was answered and refused, so nothing
// happened at the far end and trying again is safe.
export type SendOutcome =
  | { readonly kind: "sent"; readonly res: HttpResponse }
  | { readonly kind: "refused" }
  | { readonly kind: "unanswered" };

// The transport's reply, narrowed to what the surface reads: the status (which
// decides retry, standing down, or nothing) and the body (which carries the new
// thread's id on a create).
export interface HttpResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

// The injected transport — `fetch`'s shape, minus everything unused.
export type Fetch = (
  url: string,
  init: SendInit & { signal?: AbortSignal },
) => Promise<HttpResponse>;

// Where a warning goes when the surface breaks silence. Injected so a test can assert
// that it happened exactly once; defaults to stderr.
export type Warn = (line: string) => void;

// The run surface the loop drives. With no webhook every method is a silent no-op.
// With one, `openThread` must succeed before anything else sends — a forum channel
// accepts no message outside a thread — and it returns the surface's STATUS for the
// preview, or null when there is nothing to say. The status is a bare phrase: the
// preview owns its own label column, so this module does not spell one.
export interface DiscordSurface {
  readonly active: boolean;
  openThread(o: {
    spec: number;
    title: string;
    specBranch: string;
    slices: number;
    dryRun: boolean;
    repeat: boolean;
  }): Promise<string | null>;
  noteSliceBuilding(o: { slice: number; position: number; total: number }): Promise<void>;
  noteSliceMerged(o: { slice: number; position: number; total: number }): Promise<void>;
  notifyHalt(o: {
    spec: number;
    reason: string;
    refused: boolean;
    runLog: string;
    issueUrl: string;
  }): Promise<void>;
  notifyComplete(o: { spec: number; merged: number; issueUrl: string }): Promise<void>;
}

// Build the surface from the environment and a transport. The thread id lives in this
// closure and nowhere else: one local process owns the run from kickoff to final PR,
// so nothing needs persisting and the *no local state* rule (ADR-0006) is untouched —
// it governs the state a run RESUMES from, and this is not that.
export function createDiscordSurface(
  env: NodeJS.ProcessEnv,
  fetchImpl: Fetch,
  warn: Warn = (line) => console.error(line),
): DiscordSurface {
  const resolution = resolveDiscord(env);
  const webhook = resolution.state === "ready" ? resolution.webhook : null;
  let threadId: string | null = null;
  // Set by a failed create or a 404, and never unset. Distinct from "no webhook":
  // this is a surface that WAS configured and has stopped working.
  let disabled = false;
  // Whether a 404 is what stopped it, so the preview can name the real cause instead
  // of sending the developer off to check their channel type.
  let notFound = false;

  // One send. Reports WHICH kind of failure, because the create has to tell "Discord
  // refused this" (nothing was created, retrying is safe) from "nobody answered"
  // (it may have been created, retrying would duplicate it). Nothing else looks.
  const send = async (payload: Record<string, unknown>): Promise<SendOutcome> => {
    if (!webhook) return { kind: "unanswered" };
    const { url, init } = sendRequest(webhook, threadId, payload);
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
      // Discord documents that a webhook returning 404 must not be retried, on pain
      // of an IP-level restriction at 10,000 invalid requests in ten minutes. It also
      // means the webhook is gone, so every later send in this process would fail
      // silently forever — the worst diagnostic case this design has.
      if (res.status === 404) {
        if (!disabled) {
          disabled = true;
          notFound = true;
          // ADR-0012 makes this one of exactly two things that may break silence, and
          // specifies stderr. It prints even during the create, where the preview also
          // names the cause: the two go to different streams, so a developer who has
          // redirected stdout to a log still sees why the surface went quiet.
          warn(
            `discord: the webhook returned 404 — it has been deleted or rotated. ` +
              `Run reporting is off for the rest of this process (the run is unaffected).`,
          );
        }
        return { kind: "refused" };
      }
      return res.status >= 200 && res.status < 300 ? { kind: "sent", res } : { kind: "refused" };
    } catch {
      // Best-effort: a timeout, a DNS failure, a severed network. The run does not
      // care and must never hear about it — but the create does, because this is the
      // case where the far end's state is unknowable.
      return { kind: "unanswered" };
    }
  };

  // Post into the run's thread once it exists. Everything before that is dropped
  // rather than sent, because a forum channel would reject it anyway.
  const post = async (payload: Record<string, unknown>): Promise<void> => {
    if (!webhook || disabled || !threadId) return;
    await send(payload);
  };

  return {
    get active() {
      return webhook !== null && !disabled;
    },

    async openThread(o) {
      // Rule 1: UNSET is silent. No line, no warning, nothing.
      if (resolution.state === "unset") return null;
      // Set but unusable is NOT a third exception to silence — it is the first one
      // (a failed create) reached before a request is worth making. Somebody meant to
      // configure this and got it wrong; saying nothing would leave them believing it
      // works, which is the hole the loud exceptions exist to close.
      if (resolution.state === "unusable") {
        disabled = true;
        return `off (${resolution.detail})`;
      }
      const payload = {
        thread_name: threadName({ spec: o.spec, title: o.title, repeat: o.repeat }),
        content: runStartedContent({
          specBranch: o.specBranch,
          slices: o.slices,
          dryRun: o.dryRun,
        }),
      };
      // Once, then once more — but ONLY when Discord answered and refused. The retry
      // is deliberately shallow, deliberately confined to the create, and deliberately
      // blind to the unanswered case: `thread_name` is NOT an idempotency key — the
      // same name posted twice yields two threads (verified by probe, ADR-0012) — so
      // retrying a create that had actually succeeded leaves a duplicate. That is the
      // same argument ADR-0012 uses against persisting the thread id, and it applies
      // to a 2s swallow-everything budget here for exactly the same reason: a timeout
      // cannot tell "the create failed" from "the create succeeded slowly". A 404 is
      // never retried either, and `send` has already stood the surface down by then.
      let unanswered = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const outcome = await send(payload);
        if (outcome.kind === "sent") {
          const id = await readMessageId(outcome.res);
          if (id) {
            // The returned message's `id` IS the new thread's id (its `channel_id`
            // equals it) — undocumented, and verified by probe rather than assumed.
            threadId = id;
            return `spec #${o.spec} thread created`;
          }
          // A 2xx with no readable id: Discord SAVED the message, so the thread is
          // there and merely unaddressable. Retrying would post a second one.
          break;
        }
        if (outcome.kind === "unanswered") {
          unanswered = true;
          break;
        }
        if (disabled) break;
      }
      // The first loud exception. A forum channel accepts no message outside a
      // thread, so this has silenced the whole run — including the halt notification
      // the surface exists to deliver. The preview is the one moment the developer is
      // still looking, so it is said there, and the run proceeds regardless.
      disabled = true;
      if (notFound) return "off (the webhook returned 404 — it has been deleted or rotated)";
      // Named apart from a refusal because they send the developer to different
      // places: an unanswered create may have left a thread nobody will post into,
      // while a refused one means the channel is very likely not a forum channel.
      if (unanswered) return "off (the thread create went unanswered — it may still exist)";
      return "off (the thread could not be created — is the channel a forum channel?)";
    },

    async noteSliceBuilding(o) {
      await post({ content: sliceBuildingContent(o) });
    },

    async noteSliceMerged(o) {
      await post({ content: sliceMergedContent(o) });
    },

    async notifyHalt(o) {
      await post({ embeds: [haltEmbed(o)] });
    },

    async notifyComplete(o) {
      await post({ embeds: [completeEmbed(o)] });
    },
  };
}

// The new thread's id from a create's reply, or null when the reply is unusable — a
// 200 with no id is a create that did not happen, and must be treated as one rather
// than leaving the run posting into nowhere.
async function readMessageId(res: HttpResponse): Promise<string | null> {
  try {
    const body = (await res.json()) as { id?: unknown } | null;
    const id = body && typeof body === "object" ? body.id : undefined;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

// `3 slices`, `1 slice`.
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// Truncate to a hard character budget, with an ellipsis that counts against it.
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
