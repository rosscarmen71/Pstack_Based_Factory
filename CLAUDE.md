# Pstack Based Factory

A software factory: a loop that turns tasks into PRs, reviews them and fixes them, using pstack-style skills. Adapted
from app-vitals/how-to-factory. TypeScript on Bun, strict mode.

## Layout

- `factory/`: the loop (`loop.ts`), queue view (`queue-server.ts`), supporting modules, and their tests next to them
  (`*.test.ts`).
- The factory's data lives outside every repository, in `~/.pstack-factory/` (`PSTACK_FACTORY_HOME` moves it): the
  list of projects, the settings, and one folder per project (a project is a GitHub repository) with its `tasks.json`,
  audit log, attempt counts, loop state and agent worktrees. `factory/home.ts` and `factory/projects.ts` own those
  paths; nothing else should build one.
- A project's `tasks.json` is its task queue. `take_order` appends to it; `customize_order` edits one task's text
  after the engineer approves; the loop moves `status`; dependencies change only through `factory deps set`. Skills
  find the file with `factory tasks-file`.
- `factory/skills/`: all skills, found by Claude Code through the `.claude/skills` symlink. The loop runs `/cook {id}`,
  `/taste_test {pr}` and `/remake {pr}`; `/take_order` and `/customize_order {pr}` are run by a human.

## Commands

- `bun install`: install deps
- `bun run lint`: Biome lint (no formatter)
- `bun run typecheck`: `tsc --noEmit`
- `bun test`: the factory's own tests
- `bun run factory install`: install the `factory` command and the skills for this user
- `bun run loop`: run the factory (one loop per project)
- `bun run queue`: read-only queue and history view of this repository's project on 127.0.0.1:4040

## Conventions

- Branches are `<type>/<task-id>`. PR titles and commits are Conventional Commits (`feat:`, `fix:`, `refactor:`,
  `docs:`, `chore:`); `pr-title-lint` enforces the PR title.
- Tests are not mandatory for features. Prove each acceptance criterion with its proof type: `test`, `live` or
  `manual`. If a feature has tests, they must pass.
- CI (`.github/workflows/ci.yml`) runs lint, typecheck and `bun test`. `secret-scan` runs gitleaks on every PR.
