# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Agent messaging: `ListAgents` and `SendMessage`, so a session can address
  subagents and other live sessions by `@name` and hand them work. `SendMessage`
  returns a delivery acknowledgement (`accepted`, `held`, `refused`, `duplicate`)
  rather than an answer; a reply arrives later as an incoming message.
- Session naming: a name is generated at startup and can be set with `--name` or
  `/rename`. Names are lowercase slugs; a taken name becomes `name-2`, and two live
  sessions that still collide are listed as `@name#id`.
- Discovery by files, not a daemon: every messaging-capable session writes a
  registration file under `~/.deepseek-code/registry/` and heartbeats it. Sessions
  in a different filesystem namespace — a container or WSL2 distro — simply cannot
  see each other.
- A per-session socket as the transport: a Unix domain socket, falling back to
  `/tmp/cc-socks-<uid>/` when the home directory cannot host one, and a named pipe
  on Windows. One newline-delimited JSON message per connection, authenticated by
  a per-session token held in the registration file. The token and the socket
  address are exported as `CLAUDE_CODE_MESSAGING_TOKEN` and
  `CLAUDE_CODE_MESSAGING_SOCKET` so a session's own child processes can post back
  into it.
- Inbound delivery semantics: a message is queued and read between tool calls, or
  as the next turn when the session is idle, so it never interrupts a running tool.
  The inbox caps at 50 messages, throttles bursts and suppresses identical repeats,
  and its accept/hold/refuse gate defaults from the receiver's permission class — a
  `bypassPermissions` session holds messages for approval, since a lower-trust peer
  must not be able to drive a higher-trust one.
- A peer message is explicitly **not the user**: it cannot satisfy a permission
  prompt, and a peer-driven turn is refused `Write`/`Edit` on settings and config
  files.

### Fixed

- `scripts/install.sh` is executable in the repository again, so the documented
  `./scripts/install.sh <tarball>` works on macOS and Linux. It had been
  committed without the bit, which a Windows checkout can neither set nor
  report — the README's own instruction was failing with "Permission denied".

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
