// What `agent-workflows status` was asked for, resolved against the terminal it is
// printing to (issues #97 and #98). The decide half of the decide/dispatch split, like
// `gather.mts`: the entry point reads `process.argv` and `process.stdout.isTTY` and
// hands both to this, so every rule below is testable without a terminal.

export interface StatusOptions {
  // Whether the RENDERER should paint. Colour is a property of the output device, not
  // of the tree — so it is decided once, here, and passed down.
  readonly colour: boolean;
  // Whether the RENDERER should link the issue reference and drop the URL column. A
  // separate terminal capability from colour (Apple Terminal paints but ignores OSC 8), so
  // it is decided on its own and neither flag implies the other.
  readonly hyperlinks: boolean;
  // How often the view checks for changes, or null for the one-shot render that is still
  // the default. A tick is a check, not necessarily a redraw (#106): it fetches only when
  // something changed.
  readonly watchIntervalMs: number | null;
  // Whether to lead the view with the account's quota headroom. Unlike colour and
  // hyperlinks this is not a terminal capability, so it does not follow the TTY: piping
  // the view to a file keeps the line, because it is information rather than decoration.
  readonly headroom: boolean;
}

export type ParseResult =
  | { readonly ok: true; readonly options: StatusOptions }
  | { readonly ok: false; readonly message: string };

// Both spellings: the repo's prose is British, the CLI convention is not, and a user who
// guesses the other one should not get an error about an unknown flag.
const NO_COLOUR = ["--no-color", "--no-colour"];
// The escape hatch for a terminal that paints but does not honour OSC 8 (Apple Terminal
// prints the reference as plain, unclickable text). One spelling: unlike colour it has no
// British variant to guess wrong.
const NO_HYPERLINKS = "--no-hyperlinks";
// The escape hatch in the OTHER direction, and what makes the Herdr default below safe to
// hard-code: a multiplexer that gains working OSC 8 support must not leave this view stuck
// with the URL column until the package ships a release.
const HYPERLINKS = "--hyperlinks";
const WATCH = "--watch";
const INTERVAL = "--interval";
// Both conventional spellings, because a person reaching for help is by definition not
// reading a flag list to find out which one this command wants.
const HELP = ["-h", "--help"];
// The escape hatch for the quota line. Two reasons a consumer wants it, and the second is
// the load-bearing one: the line costs a subprocess per render, and — more importantly —
// it reports the headroom of whichever account is authenticated LOCALLY. Where a repo's CI
// runs on a different subscription from the person reading the view, the number is true but
// says nothing about the fleet on screen, and printing it beside the tree would imply
// otherwise.
//
// Named for what it suppresses in the vocabulary `CONTEXT.md` sets — *quota headroom* — and
// deliberately NOT `--no-usage`: that glossary entry rules the word out precisely because
// consumption already incurred points at the opposite decision from the one this line is
// read to make.
const NO_HEADROOM = "--no-headroom";

// Herdr (a terminal multiplexer for coding agents) sets `HERDR_ENV=1` in every pane it
// owns. Measured against Herdr 0.8.0 under Ghostty: an OSC 8 hyperlink inside a pane opens
// on NEITHER route — not on ⌘-click, which Herdr receives and does not act on, nor on
// ⌘-Shift-click, which bypasses Herdr's mouse capture and reaches the host terminal with no
// hyperlink to find. Herdr's plain-URL clicking works on both routes, so inside Herdr the
// URL column is a WORKING click target while the escape is an inert one. Hyperlinks
// therefore default off here: the difference between a reachable row and a row carrying
// neither a link nor a URL.
//
// This IS capability detection, which ADR-0007 rejected — but what it rejected was a table
// of terminal NAMES that goes stale silently. This is one variable the tool sets itself, it
// fails toward the URL column rather than toward a broken row, and `--hyperlinks` overrides
// it the day Herdr fixes this. See the ADR amendment.
const HERDR = "HERDR_ENV";

// A tick now costs one conditional read and a branch listing rather than a full fetch of
// the tree (ADR-0007, #106), so the cadence is what a person watching a spec build wants:
// a label change shows up in about five seconds — measured detection latency for the
// conditional read is around four — rather than up to thirty.
export const DEFAULT_INTERVAL_SECONDS = 5;

// The floor is the round trip of the tick itself, not the shared rate limit: a `304` is
// free, so a tight interval no longer starves the fleet — but an interval shorter than
// the tick's own round trip would just stack checks on top of each other, so it is refused
// rather than silently raised to something the user did not ask for.
export const MIN_INTERVAL_SECONDS = 2;

// The ceiling is the timer's, not a taste: `setTimeout` overflows past ~24.8 days and
// fires IMMEDIATELY instead, so an absurd interval would turn into the hot loop the floor
// exists to prevent. An hour is well inside that and past any watch worth leaving open.
export const MAX_INTERVAL_SECONDS = 3600;

// Whether the command was asked for its help, answered WITHOUT parsing (issue #123).
//
// Separate from `parseStatusArgs` on purpose, and this is the whole of the precedence
// rule: a help flag is looked for before anything is validated, so `status --json -h`
// prints the option list rather than a refusal naming `--json`. Someone asking what the
// options are is exactly the person who just got one wrong.
export function wantsHelp(argv: readonly string[]): boolean {
  return argv.some((arg) => HELP.includes(arg));
}

// The option table, in the order a person meets the options: what to do, then how it
// should look, then the way out. Built from the constants above rather than restating
// them, so a renamed flag or a moved bound cannot leave the help describing the last
// release — the same reason `INSTALL_USAGE` lives beside the installer's parser.
const OPTIONS: readonly (readonly [string, string])[] = [
  [WATCH, `redraw every ${DEFAULT_INTERVAL_SECONDS}s until ctrl-c (needs a terminal)`],
  [
    `${INTERVAL} <seconds>`,
    `how often ${WATCH} checks — ${MIN_INTERVAL_SECONDS} to ${MAX_INTERVAL_SECONDS} whole seconds`,
  ],
  [NO_COLOUR.join(", "), "print without colour"],
  [NO_HYPERLINKS, "print the URL column instead of linking the reference"],
  [HYPERLINKS, "link the reference anyway (needs a terminal)"],
  [NO_HEADROOM, "drop the quota headroom line"],
  [HELP.join(", "), "print this and exit, reading nothing"],
];

const FLAG_COLUMN = Math.max(...OPTIONS.map(([flags]) => flags.length));

// What `-h` prints, wrapped inside 80 columns so it survives the narrow terminal a help
// flag tends to be typed into. Both invocation forms are named because a consuming repo's
// developer meets this view through the package script and has no reason to know the
// binary behind it — and the person who typed the binary has no reason to know the script.
export const STATUS_USAGE = [
  "usage: agent-workflows status [options]",
  "       yarn agent:status [options]",
  "",
  "Prints the specs currently building in the repo you are standing in, with",
  "their tracer-bullets nested beneath. Read-only: it runs no agent and writes",
  "nothing.",
  "",
  ...OPTIONS.map(([flags, description]) => `  ${flags.padEnd(FLAG_COLUMN)}  ${description}`),
  "",
  "Colour and hyperlinks follow the output device: both are off when stdout is",
  "not a terminal, so redirected output is clean text carrying the URL column in",
  `place of the links. ${WATCH} needs a terminal for its own reason — each redraw`,
  "replaces the last.",
  "",
  `Inside Herdr (${HERDR}=1) hyperlinks default off: there the escape is inert`,
  `while the URL column is a working click target. ${HYPERLINKS} overrides that.`,
].join("\n");

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
      message: `${INTERVAL}: ${raw}s is too tight — the floor is ${MIN_INTERVAL_SECONDS}s, shorter than the round trip of a single check.`,
    };
  }
  if (seconds > MAX_INTERVAL_SECONDS) {
    return {
      message: `${INTERVAL}: ${raw}s is beyond the ${MAX_INTERVAL_SECONDS}s ceiling — past it the timer overflows and fires without pausing at all.`,
    };
  }
  return { ms: seconds * 1000 };
}

// Colour and hyperlinks are each emitted only to a terminal, so piping the view to a file
// or another command yields clean text with no escape sequences to strip; `--no-color` and
// `--no-hyperlinks` each override their own capability downwards, independently. Hyperlinks
// additionally need a terminal that can ACT on the escape, which is why the environment is
// an input here — `--hyperlinks` forces them back on, but only where they could be honoured
// at all, so redirected output keeps its URL column. `--watch` turns the single render into
// a redraw loop and is the only option that takes a value.
//
// Nothing is silently ignored: an option the view does not have, or one that cannot mean
// anything in the combination given, is refused with a message naming it.
export function parseStatusArgs(
  argv: readonly string[],
  isTTY: boolean,
  env: NodeJS.ProcessEnv,
): ParseResult {
  const args = argv.filter(Boolean);

  let colour = isTTY;
  // A terminal AND one that can act on the escape: inside Herdr the link is inert and the
  // URL column it would replace is not, so the row is better off with the column.
  let hyperlinks = isTTY && env[HERDR] !== "1";
  // Held separately from the resolved value so the two flags can be caught contradicting
  // each other rather than resolved last-one-wins.
  let forced = false;
  let suppressed = false;
  let watch = false;
  let headroom = true;
  let interval: number | null = null;
  const unknown: string[] = [];
  // Held rather than thrown at once, so a command with both a bad interval AND an
  // unknown flag reports the unknown flag too instead of one round-trip per mistake.
  let intervalError: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (NO_COLOUR.includes(arg)) {
      colour = false;
    } else if (arg === NO_HYPERLINKS) {
      suppressed = true;
      hyperlinks = false;
    } else if (arg === HYPERLINKS) {
      forced = true;
      hyperlinks = true;
    } else if (arg === WATCH) {
      watch = true;
    } else if (arg === NO_HEADROOM) {
      headroom = false;
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
      `unknown option(s): ${unknown.join(" ")} — the status view takes ${WATCH}, ${INTERVAL} <seconds>, ${NO_COLOUR[0]}, ${NO_HYPERLINKS}, ${HYPERLINKS} and ${NO_HEADROOM}.`,
    );
  }
  if (intervalError !== null) return refuse(intervalError);
  // Contradictory rather than last-one-wins: the view cannot both link and not link, and
  // guessing which was meant is worse than saying so.
  if (forced && suppressed) {
    return refuse(`${HYPERLINKS} and ${NO_HYPERLINKS} contradict each other — pass one or the other.`);
  }
  // The two flags are deliberately asymmetric off a terminal, and that is a decision rather
  // than an oversight. DOWNWARDS is always safe: `--no-hyperlinks` in a pipe only withholds
  // an escape a pipe never wanted, so it is a harmless no-op. UPWARDS is not: `--hyperlinks`
  // would emit escapes AND drop the URL column, leaving redirected output with no reachable
  // target at all. So the one that can lose information is named rather than swallowed.
  if (forced && !isTTY) {
    return refuse(
      `${HYPERLINKS} needs a terminal — stdout here is not one, and in redirected output the URL column is what carries the link.`,
    );
  }
  if (interval !== null && !watch) {
    return refuse(`${INTERVAL} only means something with ${WATCH} — a single render has no cadence.`);
  }
  // Each redraw REPLACES the last, which a pipe or a file cannot do. Refusing beats
  // appending a frame every few seconds to something nobody is watching.
  if (watch && !isTTY) {
    return refuse(`${WATCH} redraws in place, which needs a terminal — stdout here is not one.`);
  }

  return {
    ok: true,
    options: {
      colour,
      hyperlinks,
      watchIntervalMs: watch ? (interval ?? DEFAULT_INTERVAL_SECONDS * 1000) : null,
      headroom,
    },
  };
}
