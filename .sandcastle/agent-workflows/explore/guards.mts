// `explore-guards` hook. Exploration is read-only and safe on any open issue, so
// there is no preflight to run — exit 0 (proceed). Present for contract
// uniformity and as the seam where an explore-specific refusal would live.
process.exit(0);
