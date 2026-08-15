// `agent-workflows status --watch` — the redraw loop (issue #98). A REDRAW ONLY: no key
// bindings, no input handling, no layout engine. Nothing here reads stdin, so Ctrl-C
// stays the terminal's own SIGINT rather than something this has to interpret, and a
// persistent TUI stays out of scope (ADR-0007).
//
// The loop is separated from the entry point for the same reason `gather.mts` was: it
// has a real bug surface — a frame drawn after the abort, a `gh` blip killing an
// overnight watch, a terminal left in the alternate screen with no cursor — and an entry
// point that runs on import cannot be tested. Timing and the terminal are both injected,
// so the tests spend no wall-clock and need no TTY.

import { setTimeout as delay } from "node:timers/promises";

import { statusFrame, type RunningVersion } from "./frame.mts";

// The terminal, as this loop uses it. Three calls, so a fake in a test is three lines.
export interface Screen {
  readonly enter: () => void;
  readonly draw: (frame: string) => void;
  readonly leave: () => void;
}

export interface WatchLoop {
  // One full pass — fetch, resolve, render — returning the view to show. Called once
  // per interval, and allowed to throw: the loop shows the failure instead of dying.
  readonly render: () => string;
  readonly screen: Screen;
  readonly intervalMs: number;
  // Resolved once by the entry point, before the loop starts, and held for the life of the
  // process: one watch must never claim to have changed release while still running the code
  // it started with.
  readonly version: RunningVersion;
  // Aborted by the entry point's SIGINT/SIGTERM handler. The wait ends early on abort,
  // so Ctrl-C is felt at once rather than at the end of the interval.
  readonly signal: AbortSignal;
  // Seams for the tests, so they spend no wall-clock and get a fixed footer clock. The
  // defaults are what production uses.
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => Date;
}

export async function watchStatus({
  render,
  screen,
  intervalMs,
  version,
  signal,
  sleep = abortableSleep,
  now = () => new Date(),
}: WatchLoop): Promise<void> {
  screen.enter();
  try {
    while (!signal.aborted) {
      const body = frame(render);
      // A pass is seconds of blocking `gh` calls, and the abort can land in the middle of
      // one. Painting the frame it produced would put a screen up that nobody is there
      // for and undo the restore below.
      if (signal.aborted) break;
      // The footer is the shared frame formatter's (`frame.mts`), not this loop's: without a
      // clock and an interval on it, a screen that has not changed in an hour is
      // indistinguishable from a watch that died — and its wording has to be the one-shot
      // view's, so the two surfaces cannot imply different version concepts.
      screen.draw(statusFrame(body, version, { intervalMs, at: now() }));
      await sleep(intervalMs, signal);
    }
  } finally {
    // The one thing that must happen on every path, abort or crash alike: a terminal
    // left in the alternate screen with a hidden cursor looks broken long after this
    // process is gone.
    screen.leave();
  }
}

// A watch is left open for hours, so a single failed `gh` call — a dropped VPN, a rate
// limit, a five-second outage — is a blip to report, not a reason to tear the pane down.
// The next redraw recovers on its own.
function frame(render: () => string): string {
  try {
    return render();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `could not read the tracker: ${message}\n\nretrying on the next redraw.`;
  }
}

// Waits out the interval, and gives up the moment the signal aborts — `node:timers`'
// own signal support rather than a hand-rolled listener, which on a watch left open
// overnight would attach one per redraw and never take them off. An abort rejects, and
// the loop's own `signal.aborted` check is what acts on it, so there is nothing to do
// with the error but swallow it.
async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch {
    // Aborted mid-wait: the loop condition sees it.
  }
}

// The alternate screen buffer: the watch gets a screen of its own and the scrollback the
// user had before it is intact when they quit — which `clear` alone would have eaten.
const ENTER = "\x1b[?1049h\x1b[?25l"; // alternate screen, cursor hidden
const LEAVE = "\x1b[?25h\x1b[?1049l"; // cursor back, original screen back
const HOME_AND_CLEAR = "\x1b[H\x1b[2J";

export function terminalScreen(out: { write: (chunk: string) => void }): Screen {
  return {
    enter: () => out.write(ENTER),
    // Home-then-clear in one write, so a frame replaces its predecessor in a single
    // paint rather than flashing an empty screen between the two.
    draw: (frame) => out.write(`${HOME_AND_CLEAR}${frame}\n`),
    leave: () => out.write(LEAVE),
  };
}
