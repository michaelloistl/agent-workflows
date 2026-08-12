// What `agent-workflows status` was asked for, resolved against the terminal it is
// printing to (issues #97 and #98). The decide half of the decide/dispatch split, like
// `gather.mts`: the entry point reads `process.argv` and `process.stdout.isTTY` and
// hands both to this, so every rule below is testable without a terminal.

export interface StatusOptions {
  // Whether the RENDERER should paint. Colour is a property of the output device, not
  // of the tree — so it is decided once, here, and passed down.
  readonly colour: boolean;
  // How often to redraw, or null for the one-shot render that is still the default.
  readonly watchIntervalMs: number | null;
}

export type ParseResult =
  | { readonly ok: true; readonly options: StatusOptions }
  | { readonly ok: false; readonly message: string };

// Both spellings: the repo's prose is British, the CLI convention is not, and a user who
// guesses the other one should not get an error about an unknown flag.
const NO_COLOUR = ["--no-color", "--no-colour"];
const WATCH = "--watch";
const INTERVAL = "--interval";

// Roughly two to four GitHub calls per redraw (ADR-0007), so 30s is ~480 calls an hour
// against an authenticated 5,000 — a watch can be left open all day beside the agent
// runs that share the budget.
export const DEFAULT_INTERVAL_SECONDS = 30;

// The floor exists for that same shared budget, not as a preference: a one-second watch
// would spend the hour's calls in minutes and starve the fleet, so it is refused rather
// than silently raised to something the user did not ask for.
export const MIN_INTERVAL_SECONDS = 5;

// The ceiling is the timer's, not a taste: `setTimeout` overflows past ~24.8 days and
// fires IMMEDIATELY instead, so an absurd interval would turn into the hot redraw loop
// the floor exists to prevent. An hour is well inside that and past any watch worth
// leaving open.
export const MAX_INTERVAL_SECONDS = 3600;

function refuse(message: string): ParseResult {
  return { ok: false, message };
}

// Seconds, as a whole number within the two bounds — the value is a person's cadence, so
// it is validated rather than coerced, and every rejection names the value that was
// wrong.
function parseInterval(raw: string | undefined): { ms: number } | { message: string } {
  // A following flag is a missing value, not a value: `--interval --no-color` means the
  // user forgot the number, and consuming the flag would hide that. `--interval=` is the
  // same mistake in the other spelling.
  if (raw === undefined || raw === "" || raw.startsWith("--")) {
    return { message: `${INTERVAL} needs a value in seconds, e.g. ${INTERVAL} 30.` };
  }
  const seconds = Number(raw);
  if (!Number.isInteger(seconds)) {
    return { message: `${INTERVAL}: ${raw} is not a whole number of seconds.` };
  }
  if (seconds < MIN_INTERVAL_SECONDS) {
    return {
      message: `${INTERVAL}: ${raw}s is too tight — the floor is ${MIN_INTERVAL_SECONDS}s, so a long watch stays inside the GitHub rate limit.`,
    };
  }
  if (seconds > MAX_INTERVAL_SECONDS) {
    return {
      message: `${INTERVAL}: ${raw}s is beyond the ${MAX_INTERVAL_SECONDS}s ceiling — past it the timer overflows and redraws without pausing at all.`,
    };
  }
  return { ms: seconds * 1000 };
}

// Colour is emitted only to a terminal, so piping the view to a file or another command
// yields clean text with no escape sequences to strip; `--no-color` overrides that
// downwards only, since nothing yet needs colour forced into a pipe. `--watch` turns the
// single render into a redraw loop and is the only option that takes a value.
//
// Nothing is silently ignored: an option the view does not have, or one that cannot mean
// anything in the combination given, is refused with a message naming it.
export function parseStatusArgs(argv: readonly string[], isTTY: boolean): ParseResult {
  const args = argv.filter(Boolean);

  let colour = isTTY;
  let watch = false;
  let interval: number | null = null;
  const unknown: string[] = [];
  // Held rather than thrown at once, so a command with both a bad interval AND an
  // unknown flag reports the unknown flag too instead of one round-trip per mistake.
  let intervalError: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (NO_COLOUR.includes(arg)) {
      colour = false;
    } else if (arg === WATCH) {
      watch = true;
    } else if (arg === INTERVAL || arg.startsWith(`${INTERVAL}=`)) {
      // `--interval 30` and `--interval=30` both, since a user who guesses the other
      // form is asking for the same thing.
      const raw = arg.startsWith(`${INTERVAL}=`) ? arg.slice(INTERVAL.length + 1) : args[++i];
      const parsed = parseInterval(raw);
      if ("message" in parsed) intervalError ??= parsed.message;
      else interval = parsed.ms;
    } else {
      unknown.push(arg);
    }
  }

  // Rejected rather than ignored: a flag that does nothing must say so instead of
  // appearing to work.
  if (unknown.length > 0) {
    return refuse(
      `unknown option(s): ${unknown.join(" ")} — the status view takes ${WATCH}, ${INTERVAL} <seconds> and ${NO_COLOUR[0]}.`,
    );
  }
  if (intervalError !== null) return refuse(intervalError);
  if (interval !== null && !watch) {
    return refuse(`${INTERVAL} only means something with ${WATCH} — a single render has no cadence.`);
  }
  // Each redraw REPLACES the last, which a pipe or a file cannot do. Refusing beats
  // appending a frame every 30 seconds to something nobody is watching.
  if (watch && !isTTY) {
    return refuse(`${WATCH} redraws in place, which needs a terminal — stdout here is not one.`);
  }

  return {
    ok: true,
    options: {
      colour,
      watchIntervalMs: watch ? (interval ?? DEFAULT_INTERVAL_SECONDS * 1000) : null,
    },
  };
}
