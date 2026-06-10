// Test environment setup — runs before any test module is imported.
// Sets SYMPHONY_SHARE_ROOT so paths.ts resolves against the project root,
// giving the same behaviour as the current SYMPHONY_STATIC_ROOT="./frontend/dist" default.
if (!process.env.SYMPHONY_SHARE_ROOT) {
  process.env.SYMPHONY_SHARE_ROOT = ".";
}
