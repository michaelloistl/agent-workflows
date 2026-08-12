// What `agent-workflows status` was asked for, resolved against the terminal it is
// printing to (issue #97). The decide half of the decide/dispatch split, like
// `gather.mts`: the entry point reads `process.argv` and `process.stdout.isTTY` and
// hands both to this, so the rule is testable without a terminal.

export interface StatusOptions {
  // Whether the RENDERER should paint. Colour is a property of the output device, not
  // of the tree — so it is decided once, here, and passed down.
  readonly colour: boolean;
}

export type ParseResult =
  | { readonly ok: true; readonly options: StatusOptions }
  | { readonly ok: false; readonly message: string };

// Both spellings: the repo's prose is British, the CLI convention is not, and a user who
// guesses the other one should not get an error about an unknown flag.
const NO_COLOUR = ["--no-color", "--no-colour"];

// Colour is emitted only to a terminal, so piping the view to a file or another command
// yields clean text with no escape sequences to strip. `--no-color` overrides that
// downwards only — there is no flag to force colour into a pipe, because nothing yet
// needs one.
export function parseStatusArgs(argv: readonly string[], isTTY: boolean): ParseResult {
  const args = argv.filter(Boolean);
  // Rejected rather than ignored: a flag that does nothing must say so instead of
  // appearing to work. `--watch` is issue #98 and lands here when it does.
  const unknown = args.filter((arg) => !NO_COLOUR.includes(arg));
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `unknown option(s): ${unknown.join(" ")} — the status view takes ${NO_COLOUR[0]} and nothing else.`,
    };
  }
  return { ok: true, options: { colour: isTTY && !args.some((arg) => NO_COLOUR.includes(arg)) } };
}
