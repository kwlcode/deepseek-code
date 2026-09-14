# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-09-13

### Added

- GitHub Actions. `ci.yml` runs the suite on Linux, Windows and macOS across
  Node 18, 20, 22 and 24; `release.yml` runs on `v*` tags, packs the installable
  tarball and attaches it to a GitHub release — and publishes to npm when a
  repository secret named `NPM_TOKEN` is configured.
- `scripts/install.ps1` and `scripts/install.sh` install the newest release
  tarball without cloning anything first.
- `.gitattributes` keeps text files LF in the repository, so shell scripts stay
  executable on Unix whatever the checkout platform.

## [0.1.0] - 2026-09-13

First release.

### Added

- Interactive REPL and one-shot `-p/--print` mode, plus `doctor`, `models` and
  `sessions` subcommands.
- Streaming chat completions against DeepSeek's OpenAI-compatible API, with
  reasoning (`thinking`) streamed to the terminal and prompt-cache aware cost
  reporting.
- Tools: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `PowerShell`,
  `TodoWrite`, `WebFetch` and `Task` (subagents).
- Permission modes `plan`, `default`, `acceptEdits` and `bypassPermissions`
  (aliases `--yolo` / `--dangerously-skip-permissions`), with Claude Code rule
  syntax (`Bash(git commit:*)`, `Edit(/src/**)`, `WebFetch(domain:…)`) and
  `allow`/`deny`/`additionalDirectories` lists.
- Claude Code compatible configuration and content: `~/.deepseek-code/config.json`,
  `.deepseek-code/settings.json`, `.claude/settings.json`, `CLAUDE.md`/`AGENTS.md`
  memory files and `.claude/commands/*.md` slash commands.
- Session transcripts with `--continue` / `--resume` and `sessions` listing.
- JSON output mode (`--json`) with a strict stdout contract and diagnostics on
  stderr.

### Fixed

- `test/agent.test.js` no longer nests four of its tests inside another test,
  which made them race against their parent and fail on Node 18
  (`cancelledByParent`).
- `npm test` works on every supported Node (18.17+) and on Windows: the new
  `scripts/test.mjs` discovers `test/*.test.js` and passes explicit paths to
  `node --test` instead of relying on shell globbing or `--test` glob/directory
  handling, which differ between releases.
- One-shot `-p` mode no longer attaches a flowing stdin listener, so the process
  exits as soon as the answer is printed instead of hanging after a network
  error.
- `--json` / `-p` runs keep stdout free of notices and warnings (they now go to
  stderr), so machine-readable output stays parseable.

[0.1.1]: https://github.com/kwlcode/deepseek-code/releases/tag/v0.1.1
[0.1.0]: https://github.com/kwlcode/deepseek-code/releases/tag/v0.1.0
