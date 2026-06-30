// JSON / structured-output helpers shared by the agent-workflow entrypoints.
//
// sandcastle's `Output.object` validates the JSON it extracts from agent output
// against any Standard Schema (https://standardschema.dev) validator — it only
// calls `schema["~standard"].validate(parsed)`. We don't depend on a schema
// library (zod/valibot), so `standardSchema` builds the minimal `~standard`
// shape sandcastle needs, keeping this module dependency-free.

// The subset of a Standard Schema validation result sandcastle reads back.
export interface ValidationResult<T> {
  readonly value?: T;
  readonly issues?: ReadonlyArray<{ readonly message: string }>;
}

// A minimal Standard Schema validator, accepted by `Output.object`.
export interface StandardSchema<T> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => ValidationResult<T>;
  };
}

// Wrap a plain validate function as a Standard Schema validator.
export function standardSchema<T>(
  validate: (value: unknown) => ValidationResult<T>,
): StandardSchema<T> {
  return { "~standard": { version: 1, vendor: "sandcastle", validate } };
}
