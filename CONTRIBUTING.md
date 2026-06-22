# Contributing to nano-symphony

Thank you for your interest in contributing! This document covers the basics.

## Getting started

1. Install [Bun](https://bun.sh).
2. Clone the repo and run `bun install` in both the root and `frontend/`.
3. Copy `WORKFLOW.md` from `share/templates/WORKFLOW.example.md` or create your own.

## Development workflow

```bash
bun run lint
bun test tests/unit tests/*.test.ts
bun test tests/integration --concurrency 1
bun test tests/e2e --concurrency 1
cd frontend && bun run test
```

All tests must pass before merging.

## Pull request guidelines

- Keep changes focused and minimal.
- Update tests when changing behavior.
- Update relevant documentation (`README.md`, `docs/`, or `AGENTS.md`).
- Do not commit secrets, tokens, or personal `.env` files.
- Use clear commit messages that explain *why* the change is needed.

## Code style

- TypeScript strict mode is enforced.
- Prefer small functions and explicit error handling.
- Use Zod for request validation.
- Avoid `any`; prefer `unknown` with narrowing.

## Reporting issues

When reporting bugs, please include:

- Steps to reproduce
- Expected vs actual behavior
- `bun --version` output
- Relevant logs (with secrets redacted)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
