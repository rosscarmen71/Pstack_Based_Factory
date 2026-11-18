# Pstack Based Factory

A software factory: a loop that turns tasks into PRs, reviews them and fixes them, using pstack-style skills. Adapted
from app-vitals/how-to-factory. TypeScript on Bun, strict mode.

## Layout

- `factory/`: the loop (`loop.ts`), queue view (`queue-server.ts`), supporting modules, and their tests next to them
  (`*.test.ts`).
- `factory/tasks.json`: the task queue. `take_order` appends to it; the loop moves `status`. Skills never edit it.
- `factory/audit-log.jsonl`, `factory/pr-attempts.json`: runtime state, gitignored.
- `factory/skills/`: all skills, found by Claude Code through the `.claude/skills` symlink. The loop runs `/cook {id}`,
  `/taste_test {pr}` and `/remake {pr}`; `/take_order` is run by a human.

## Commands

- `bun install`: install deps
- `bun run lint`: Biome lint (no formatter)
- `bun run typecheck`: `tsc --noEmit`
- `bun test`: the factory's own tests
- `bun run loop`: run the loop
- `bun run queue`: read-only queue and history view on 127.0.0.1:4040

## Conventions

- Branches are `<type>/<task-id>`. PR titles and commits are Conventional Commits (`feat:`, `fix:`, `refactor:`,
  `docs:`, `chore:`); `pr-title-lint` enforces the PR title.
- Tests are not mandatory for features. Prove each acceptance criterion with its proof type: `test`, `live` or
  `manual`. If a feature has tests, they must pass.
- CI (`.github/workflows/ci.yml`) runs lint, typecheck and `bun test`. `secret-scan` runs gitleaks on every PR.
