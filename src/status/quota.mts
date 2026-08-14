// Quota headroom for the status view: the share of the account's rolling session and
// weekly limits still unconsumed. Distinct from the run ceiling, which bounds ONE run —
// headroom bounds all work everywhere, including the fleet's CI runs, because the agent
// runs on a subscription OAuth token rather than a metered API key. Reading it next to
// the spec tree answers the question the tree alone cannot: not "what is building" but
// "can I afford to let it finish".
//
// The source is `claude --strict-mcp-config --print --output-format json "/usage"`, which
// makes no model call (`num_turns: 0`, `duration_api_ms: 0`), so reading headroom does not
// spend it. What it does cost is WALL CLOCK: ~1.4s, nearly all of it process startup, and
// ~3.4s if a consumer's MCP servers are loaded — which is why the call disables them. That
// price is what shapes the rest of this file: a `--watch` tick does NOT take a fresh read
// every time, it reuses one for `QUOTA_TTL_MS` (see `throttled` at the foot). The read
// stays outside the #106 freshness gate all the same — that gate rations the shared GitHub
// rate limit, and this number moves precisely when the tree does not.
//
// Pure throughout: raw stdout in, a line out. The subprocess belongs to `run.mts`, the
// dispatch half, exactly as the `gh` calls do.
//
// THE FRAGILITY, named rather than hidden: that command returns its windows as RENDERED
// PROSE in a `result` string, not as structured data. Claude Code carries a structured
// shape internally but does not hand it over, so this parses English that a future release
// may reword. Every parse below therefore fails to `null` — never a throw, never a partial
// block — and the view drops the line and prints exactly what it prints today.

export interface QuotaWindow {
  readonly label: string;
  // 0–100, rounded for display. The source renders whole numbers today; decimals are
  // accepted so a change in its precision is not read as a parse failure.
  readonly percent: number;
  // Passed through from the prose rather than derived from a timestamp: the source has
  // already localised it correctly, and re-deriving would mean owning timezone conversion
  // for a value that arrives right. `null` for windows the source states without one —
  // the per-model line carries no reset.
  readonly resets: string | null;
}

export interface Quota {
  readonly session: QuotaWindow;
  readonly week: QuotaWindow;
  // Per-model weekly windows, in the order the source lists them. Optional and plan-
  // dependent: there may be none, one, or several, and the model names vary.
  readonly models: readonly QuotaWindow[];
}

export interface QuotaRenderOptions {
  readonly colour?: boolean;
}

// Where headroom stops receding and starts asking for attention. Chosen to mean the same
// things the tree's own palette means (`render.mts`): below ATTENTION it is dimmed like
// `pending`, because headroom that is fine is what nobody needs to scan for; at ATTENTION
// it turns yellow like `review`; at CRITICAL it goes bold red like `blocked`, the one
// state that means stop and look — here, headroom that will strand a run mid-spec.
export const ATTENTION_PERCENT = 60;
export const CRITICAL_PERCENT = 85;

// The two named windows are required, and matched by name rather than by position: the
// source is free to add rows between them. `[^)]*` for the model label because the names
// are plan-dependent and unknowable here.
const SESSION = /^Current session:\s*(\d+(?:\.\d+)?)%\s*used\b(.*)$/m;
const WEEK = /^Current week \(all models\):\s*(\d+(?:\.\d+)?)%\s*used\b(.*)$/m;
const MODEL = /^Current week \(([^)]*)\):\s*(\d+(?:\.\d+)?)%\s*used\b(.*)$/gm;

// The label the source uses for the aggregate row, which the per-model sweep must skip —
// it is already carried as `week`.
const ALL_MODELS = "all models";

type Paint = (text: string) => string;

// The same escape construction and the same codes as `render.mts`, deliberately duplicated
// rather than imported: that module's palette is keyed by spec-tree tone, and widening it
// to cover a thing that is not a row would couple a pure tree renderer to this. Four lines
// is the cheaper coupling.
const ansi =
  (...codes: number[]): Paint =>
  (text) =>
    `\x1b[${codes.join(";")}m${text}\x1b[0m`;

const DIM = ansi(2);
const ATTENTION = ansi(33);
const CRITICAL = ansi(1, 31);

function tone(percent: number): Paint {
  if (percent >= CRITICAL_PERCENT) return CRITICAL;
  if (percent >= ATTENTION_PERCENT) return ATTENTION;
  return DIM;
}

// The tail of a window line, after the percentage: ` · resets Aug 15 at 5:59am
// (Atlantic/Madeira)`. The zone is dropped because it is redundant on the machine that
// rendered it, and the "at" because the line is a status column rather than a sentence.
function resetsFrom(tail: string): string | null {
  const found = /resets\s+(.+?)\s*$/.exec(tail);
  if (!found) return null;
  const when = found[1]!
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s+at\s+/, " ")
    .trim();
  return when === "" ? null : when;
}

function windowFrom(label: string, percent: string, tail: string): QuotaWindow {
  return { label, percent: Math.round(Number(percent)), resets: resetsFrom(tail) };
}

// Raw stdout of `claude --print --output-format json "/usage"` in, the windows out, or
// `null` for anything that is not recognisably that: a non-JSON body, a JSON body with no
// `result` string, an error result, or prose missing either named window.
//
// `null` rather than a partial parse is the whole contract. A half-read block — a session
// bar with no weekly bar — would be read as "the week is fine" by someone glancing at it,
// which is the one wrong impression this view must not leave.
export function parseQuota(stdout: string): Quota | null {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as { result?: unknown; is_error?: unknown };
  // The envelope reports command failure in-band with exit code 0, so the flag is checked
  // rather than trusted to have surfaced as a throw in the caller.
  if (record.is_error === true) return null;
  const text = record.result;
  if (typeof text !== "string") return null;

  const session = SESSION.exec(text);
  const week = WEEK.exec(text);
  if (!session || !week) return null;

  // `rate_limits` is absent entirely on API-key, Bedrock and Vertex auth, and before any
  // response has populated the snapshot — in which case the prose carries no window lines
  // and the two matches above have already returned `null`.
  const models: QuotaWindow[] = [];
  MODEL.lastIndex = 0;
  for (const match of text.matchAll(MODEL)) {
    const label = match[1]!.trim();
    if (label === ALL_MODELS) continue;
    models.push(windowFrom(label, match[2]!, match[3]!));
  }

  return {
    session: windowFrom("session", session[1]!, session[2]!),
    week: windowFrom("week", week[1]!, week[2]!),
    models,
  };
}

// `used` is not decoration and is never dropped: the figure is CONSUMPTION while the thing
// it is read for is the complement, so a bare `week 37%` under a line labelled quota is read
// as "37% left" exactly as readily as "37% gone". The word is what makes the colour ramp
// legible too — rising red only means anything on the used reading.
function segment(window: QuotaWindow, colour: boolean): string {
  const resets = window.resets === null ? "" : ` (resets ${window.resets})`;
  const text = `${window.label} ${window.percent}% used${resets}`;
  return colour ? tone(window.percent)(text) : text;
}

// One compact line, not the source's block of progress bars: the status view's job is
// fitting a spec tree on screen, and reproducing `/usage` wholesale would spend the
// vertical space the tree needs to answer a question `/usage` already answers better.
//
// Each window is painted on its own threshold rather than the line taking one colour, so a
// weekly limit about to strand a run still shouts while the session bar beside it recedes.
export function formatQuota(quota: Quota, { colour = false }: QuotaRenderOptions = {}): string {
  const windows = [
    quota.session,
    quota.week,
    // Zero-percent model windows are dropped: a plan lists them whether or not the model
    // has been touched, and "Fable 0%" is noise on a line read at a glance.
    ...quota.models.filter((window) => window.percent > 0),
  ];
  return `quota · ${windows.map((window) => segment(window, colour)).join(" · ")}`;
}

// Headroom leads the view because it is read to decide whether to LET the tree run, so it
// belongs before the tree rather than after it — below, it would sit beside the watch
// footer and read as chrome. A `null` line leaves the body byte-for-byte as it was, which
// is what every failure path resolves to.
export function withQuota(body: string, line: string | null): string {
  return line === null ? body : `${line}\n\n${body}`;
}

// How long a read is reused before another is paid for. The read is NOT free — measured at
// ~1.4s of wall clock, most of it process startup — so a `--watch` tick cannot simply take
// one every time: at the 5s default that is a quarter of every tick spent blocking on a
// number that barely moves. A weekly window shifts by fractions of a percent per minute, so
// reusing one for half a minute costs nothing anybody can see, while paying for it every
// tick would visibly stall the redraw the view exists to provide.
//
// Deliberately NOT the freshness gate (`freshness.mts`), which is about the GitHub rate
// limit the fleet shares. This is a wall-clock throttle on a local subprocess and answers a
// different question, so it stays a plain interval rather than a change probe: there is
// nothing cheap to probe here, the read IS the probe.
export const QUOTA_TTL_MS = 30_000;

// Wraps a read so it is taken at most once per `ttlMs`, with the clock injected so the
// behaviour is testable without wall-clock. The first call always reads, and a failing read
// costs one attempt per window like any other — a machine with no `claude` on its PATH
// discovers that once per window rather than on every redraw.
//
// A failure does NOT immediately blank the answer, though, and that asymmetry is the point:
// on the surface where this matters — a `--watch` pane left open — one 4s timeout or one
// wedged startup would otherwise drop the line and shift the whole tree up two rows, with no
// message saying why, exactly while the window is being watched hardest. So the last good
// value is carried across exactly ONE failed window. Two consecutive failures drop it: a CLI
// that has genuinely stopped answering must not leave a percentage on screen all night that
// the reader has no way to tell is an hour stale.
export function throttled<T>(
  read: () => T | null,
  ttlMs: number = QUOTA_TTL_MS,
  now: () => number = () => Date.now(),
): () => T | null {
  let at: number | null = null;
  let last: T | null = null;
  // Whether `last` is being carried past a failure rather than freshly read — which is what
  // makes the allowance one window rather than indefinite, and resets it on recovery.
  let carried = false;
  return () => {
    const stamp = now();
    if (at === null || stamp - at >= ttlMs) {
      const fresh = read();
      at = stamp;
      if (fresh !== null) {
        last = fresh;
        carried = false;
      } else if (last !== null && !carried) {
        carried = true;
      } else {
        last = null;
        carried = false;
      }
    }
    return last;
  };
}
