import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { terminalScreen, watchFooter, watchStatus, type Screen } from "./watch.mts";

function fakeScreen() {
  const log: string[] = [];
  const frames: string[] = [];
  const screen: Screen = {
    enter: () => log.push("enter"),
    draw: (frame) => {
      log.push("draw");
      frames.push(frame);
    },
    leave: () => log.push("leave"),
  };
  return { screen, log, frames };
}

// Stands in for the interval timer: resolves at once and stops the loop after `ticks`,
// so a test spends no wall-clock waiting for a redraw.
function fakeSleep(ticks: number, controller: AbortController) {
  const waits: number[] = [];
  let elapsed = 0;
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
      if (++elapsed >= ticks) controller.abort();
    },
  };
}

const AT = new Date("2026-08-12T09:04:05");

async function run(ticks: number, render: () => string, intervalMs = 30_000) {
  const controller = new AbortController();
  const { screen, log, frames } = fakeScreen();
  const { sleep, waits } = fakeSleep(ticks, controller);
  await watchStatus({
    render,
    screen,
    intervalMs,
    sleep,
    now: () => AT,
    signal: controller.signal,
  });
  // The footer is the loop's own line; the tests below are about the view above it.
  return { log, waits, frames: frames.map((f) => f.split("\n\nwatching")[0]!) };
}

test("the first frame is drawn before the first wait", async () => {
  const { log, frames } = await run(1, () => "view");
  assert.deepEqual(log, ["enter", "draw", "leave"]);
  assert.deepEqual(frames, ["view"]);
});

test("the view is redrawn once per interval", async () => {
  let pass = 0;
  const { frames } = await run(3, () => `pass ${++pass}`);
  assert.deepEqual(frames, ["pass 1", "pass 2", "pass 3"]);
});

test("the wait is the interval it was given", async () => {
  const { waits } = await run(2, () => "view", 10_000);
  assert.deepEqual(waits, [10_000, 10_000]);
});

// Ctrl-C aborts the signal mid-wait; the loop must not draw again on the way out.
test("an abort ends the loop and restores the terminal", async () => {
  const { log } = await run(1, () => "view");
  assert.equal(log.filter((entry) => entry === "draw").length, 1);
  assert.equal(log.at(-1), "leave");
});

test("every frame carries the footer, so a still screen is not a dead one", async () => {
  const controller = new AbortController();
  const { screen, frames } = fakeScreen();
  await watchStatus({
    render: () => "view",
    screen,
    intervalMs: 30_000,
    sleep: async () => controller.abort(),
    now: () => AT,
    signal: controller.signal,
  });
  assert.equal(frames[0], `view\n\n${watchFooter(30_000, AT)}`);
});

// The pass is seconds of blocking `gh` calls; an abort landing mid-fetch must not put a
// screen up on the way out, or the restore that follows would be undone by it.
test("a frame computed before an abort is not drawn after it", async () => {
  const controller = new AbortController();
  const { screen, log } = fakeScreen();
  await watchStatus({
    render: () => {
      controller.abort(); // as if Ctrl-C landed during the fetch
      return "view";
    },
    screen,
    intervalMs: 30_000,
    sleep: async () => assert.fail("should not wait"),
    signal: controller.signal,
  });
  assert.deepEqual(log, ["enter", "leave"]);
});

test("a signal already aborted draws nothing, and still restores the terminal", async () => {
  const controller = new AbortController();
  controller.abort();
  const { screen, log } = fakeScreen();
  await watchStatus({
    render: () => assert.fail("should not render"),
    screen,
    intervalMs: 30_000,
    sleep: async () => assert.fail("should not wait"),
    signal: controller.signal,
  });
  assert.deepEqual(log, ["enter", "leave"]);
});

// A watch is left running for hours; one failed `gh` call is a blip, not a reason to
// tear the pane down. The failure is shown in place and the next redraw recovers.
test("a failed read is drawn in place and the watch keeps going", async () => {
  let pass = 0;
  const { frames } = await run(2, () => {
    if (++pass === 1) throw new Error("gh: could not resolve host");
    return "view";
  });
  assert.match(frames[0], /could not resolve host/);
  assert.equal(frames[1], "view");
});

// The one failure that must NOT be swallowed: if the loop itself breaks, an unrestored
// terminal leaves the user in the alternate screen with no cursor.
test("the terminal is restored even when drawing throws", async () => {
  const controller = new AbortController();
  const log: string[] = [];
  const screen: Screen = {
    enter: () => log.push("enter"),
    draw: () => {
      throw new Error("broken pipe");
    },
    leave: () => log.push("leave"),
  };
  await assert.rejects(
    watchStatus({
      render: () => "view",
      screen,
      intervalMs: 30_000,
      sleep: async () => controller.abort(),
      signal: controller.signal,
    }),
    /broken pipe/,
  );
  assert.deepEqual(log, ["enter", "leave"]);
});

// The wait the loop uses when nothing is injected — production's own. Two properties
// matter and neither is visible through a fake: Ctrl-C must not have to sit out the
// interval, and a watch left open overnight must not accumulate one abort listener per
// redraw.
test("the real wait ends at once on abort rather than running out the interval", async () => {
  const controller = new AbortController();
  const { screen, log } = fakeScreen();
  const started = Date.now();
  const loop = watchStatus({
    render: () => "view",
    screen,
    intervalMs: 60_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);
  await loop;
  assert.ok(Date.now() - started < 5_000, "the wait ran on past the abort");
  assert.equal(log.at(-1), "leave");
});

test("the real wait takes its abort listener off again after each redraw", async () => {
  const controller = new AbortController();
  const { screen, frames } = fakeScreen();
  let passes = 0;
  await watchStatus({
    render: () => {
      if (++passes >= 3) controller.abort();
      return "view";
    },
    screen,
    intervalMs: 1,
    signal: controller.signal,
  });
  assert.equal(passes, 3, "the loop really did redraw more than once");
  assert.deepEqual(
    getEventListeners(controller.signal, "abort"),
    [],
    "an overnight watch would accumulate one of these per redraw",
  );
  assert.ok(frames.length >= 2);
});

test("the footer says how often it redraws and how to stop", () => {
  const footer = watchFooter(30_000, new Date("2026-08-12T09:04:05"));
  assert.match(footer, /30s/);
  assert.match(footer, /ctrl-c/i);
  assert.match(footer, /09:04:05/);
});

test("the terminal screen switches buffers so the scrollback survives the watch", () => {
  const written: string[] = [];
  const screen = terminalScreen({ write: (chunk) => written.push(chunk) });

  screen.enter();
  const entered = written.join("");
  assert.match(entered, /\x1b\[\?1049h/, "the alternate screen is entered");
  assert.match(entered, /\x1b\[\?25l/, "the cursor is hidden");

  written.length = 0;
  screen.draw("view");
  const drawn = written.join("");
  assert.match(
    drawn,
    /^(\x1b\[[0-9;]*[HJ])+view/,
    "the frame is preceded by home/clear, so it replaces rather than appends",
  );

  written.length = 0;
  screen.leave();
  const left = written.join("");
  assert.match(left, /\x1b\[\?25h/, "the cursor comes back");
  assert.match(left, /\x1b\[\?1049l/, "the alternate screen is left");
});
