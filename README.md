# deepseek-code

[![CI](https://github.com/kwlcode/deepseek-code/actions/workflows/ci.yml/badge.svg)](https://github.com/kwlcode/deepseek-code/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An agentic coding CLI for the terminal, driven by DeepSeek. It mirrors the
interfaces you already know from Claude Code — the same tool names, the same
`.claude/` settings, memory files and slash commands, the same permission modes
and rule syntax — but every request goes to DeepSeek's OpenAI-compatible API.

Zero runtime dependencies: the whole CLI is plain Node.js ES modules on top of
the built-in `fetch`.

```
$ deepseek-code "add a health endpoint and a test for it"

● TodoWrite 3 task(s)
  ⎿ 1. [~] Read the server entry point
  ⎿ 2. [ ] Add GET /health
  ⎿ 3. [ ] Add a test
  ⎿ (0/3 complete)

▎ thinking
I should look at how routes are registered before editing anything.

● Read src/server.js
  ⎿ 1  import http from 'node:http';
  ⎿ 2

I'll add the route next to the existing handlers.

● Edit src/server.js
  ⎿ @@ -18,6 +18,10 @@
  ⎿ +  if (req.url === '/health') {
  ⎿ +    return json(res, 200, { ok: true });
  ⎿ +  }

● Bash: npm test
  ⎿ Tests  12 passed (12)
```

A tool call is one line — `● <Tool> <arguments>` — followed by indented `⎿`
lines for its output (red when the call failed, truncated when it is huge).
Reasoning streams dimmed under a `▎ thinking` header, todos print as a `Tasks`
block, and anything risky stops at a prompt:

```
┌─ Bash needs your approval
│ npm install left-pad
└─ [y] allow once  [a] always allow  [n] deny  [d] never allow ›
```

## Requirements

- Node.js **18.17+** (uses the global `fetch`, `AbortController` and the
  built-in test runner)
- A DeepSeek API key — `export DEEPSEEK_API_KEY=sk-...`

Every supported variable is listed in `.env.example`. The CLI reads the real
process environment only, so export them or let Node load the file (20.6+):

```bash
node --env-file=.env bin/deepseek-code.js
```

## Install

You need Node.js **18.17+** and `npm`. Every route below gives you the same two
commands: `deepseek-code` and its short alias `dsc`.

**Global install straight from GitHub** (needs `git` on your `PATH`):

```bash
npm install -g github:kwlcode/deepseek-code
```

**From the latest release tarball.** Every tagged release has the installable
`.tgz` attached, and the helpers in `scripts/` fetch it and run
`npm install -g` for you:

```powershell
# Windows
irm https://raw.githubusercontent.com/kwlcode/deepseek-code/main/scripts/install.ps1 | iex
```

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/kwlcode/deepseek-code/main/scripts/install.sh | sh
```

Both also accept a tarball you already downloaded, and `-Local` /
`NO_GLOBAL=1` installs into the current project instead of globally:

```powershell
./scripts/install.ps1 -Tarball .\deepseek-code-0.1.0.tgz
```

```bash
./scripts/install.sh ./deepseek-code-0.1.0.tgz
```

**Try it without installing anything:**

```bash
npx github:kwlcode/deepseek-code --version
```

**From a clone** (what contributors do):

```bash
git clone https://github.com/kwlcode/deepseek-code.git
cd deepseek-code
npm test        # 48 tests, no API key needed
npm link        # `deepseek-code` / `dsc` on PATH, from any directory
node bin/deepseek-code.js    # …or run the source tree directly
```

### Set your key once

The CLI reads `DEEPSEEK_API_KEY`, but a config file is easier to live with: it
works from any directory and survives a new shell.

```bash
mkdir -p ~/.deepseek-code
printf '{\n  "apiKey": "sk-your-key-here"\n}\n' > ~/.deepseek-code/config.json
```

```powershell
# Windows, PowerShell
New-Item -ItemType Directory -Force ~\.deepseek-code | Out-Null
'{ "apiKey": "sk-your-key-here" }' | Set-Content ~\.deepseek-code\config.json
```

Then:

```bash
deepseek-code doctor    # credentials, settings files, API reachability
deepseek-code           # start the REPL
```

### npm registry

The bare `deepseek-code` name on npmjs.com belongs to an unrelated package, so
`npm publish` from this repository would be rejected. Publish under a scope you
own if you want a registry entry:

```bash
npm pkg set name=@kwlcode/deepseek-code
npm publish --access public
```

Installing from GitHub or from a release tarball needs none of that.

## Quick start

```bash
deepseek-code                     # interactive REPL in the current directory
deepseek-code "explain src/api.js and add retries to streamChat"
deepseek-code -p "why does npm test fail"   # one-shot, no REPL
npm test 2>&1 | deepseek-code -p            # piped output becomes the prompt
deepseek-code -p < package.json             # same, from a file
deepseek-code doctor              # check credentials, files and API reachability
deepseek-code models              # list the models your key can use
deepseek-code sessions            # list saved sessions for this directory
```

Add `--json` for machine-readable output, or `--output-format json` to capture
the final result (text, steps, usage, session id) as one JSON object:

```bash
deepseek-code --json "how many tests are in test/?" | jq -r .result
```

In a one-shot run stdout carries only the answer (or the JSON object); warnings,
errors and notices such as `Resumed session ...` go to stderr, so `--json` stays
safe to pipe.

## Options

| Option | Meaning |
| --- | --- |
| `-m, --model <name>` | model to use (default `deepseek-flash`) |
| `--effort <low\|medium\|high>` | reasoning effort while thinking is on |
| `--no-thinking` | disable thinking mode for this run |
| `--permission-mode <mode>` | `plan`, `default`, `acceptEdits`, `bypassPermissions` |
| `--dangerously-skip-permissions` / `--yolo` | alias for `bypassPermissions` |
| `--allowed-tools <list>` / `--disallowed-tools <list>` | comma-separated tool allow/deny list |
| `--append-system-prompt <text>` | extra instructions appended to the system prompt |
| `--max-steps <n>` | agent steps per turn (default 60) |
| `--max-tokens <n>` | max output tokens per response |
| `--api-key <key>` | override `DEEPSEEK_API_KEY` |
| `--base-url <url>` | override the API base URL |
| `-r, --resume [id]` | resume a session, latest in this directory when omitted |
| `-c, --continue` | resume the most recent session |
| `-p, --print [prompt]` | non-interactive; reads the prompt from stdin when omitted |
| `--verbose` | show token usage and timing after each step |
| `--output-format <text\|json>` | print the final result as text or as one JSON object |
| `--json` | shorthand for `--output-format json` |
| `--no-color` | disable ANSI colour |
| `-h, --help` / `-v, --version` | help / version |

## Tools

The model sees the same tool names as Claude Code. All of them are implemented
in JavaScript, so no `ripgrep`/`rg` binary is required.

| Tool | Input | Notes |
| --- | --- | --- |
| `Read` | `file_path`, `offset`, `limit` | line-numbered output, capped for huge files |
| `Write` | `file_path`, `content` | creates parent directories |
| `Edit` | `file_path`, `old_string`, `new_string`, `replace_all`, or `edits: [...]` | exact-match replacement; refuses ambiguous matches |
| `Glob` | `pattern`, `path` | newest files first |
| `Grep` | `pattern`, `path`, `glob`, `output_mode`, `ignore_case`, `line_numbers`, `head_limit` | `output_mode`: `content`, `files_with_matches`, `count` |
| `Bash` | `command`, `description`, `timeout`, `run_in_background` | 2-minute default timeout, background commands return a log path |
| `PowerShell` | same as `Bash` | used on Windows for shell work |
| `TodoWrite` | `todos: [{content, status, activeForm}]` | the plan the agent shows you |
| `WebFetch` | `url`, `prompt` | fetches a page and renders it as text |
| `Task` | `description`, `prompt`, `subagent_type` | subagent definition from `.claude/agents/<type>.md`, `general-purpose` by default |

## Permissions

Four modes, selected with `--permission-mode` or switched mid-session with
`/mode`:

| Mode | Behaviour |
| --- | --- |
| `plan` | read-only: the agent researches and proposes a plan; writes are refused |
| `default` | read-only tools run freely, everything else asks |
| `acceptEdits` | file edits run freely, shell commands still ask |
| `bypassPermissions` | nothing asks (`--dangerously-skip-permissions`) |

When asked, answer `y` (once), `a` (always), `n` (no) or `d` (never). `a`/`d`
are remembered as rules; `a` writes them to
`<project>/.deepseek-code/settings.local.json` so the next session starts with
them. Rules use Claude Code's syntax:

```json
{
  "permissions": {
    "allow": ["Read", "Bash(npm run test:*)", "Edit(src/**)"],
    "deny": ["Bash(rm:*)", "WebFetch(domain:example.com)"]
  }
}
```

`Read`, `Glob`, `Grep`, `WebFetch` and `TodoWrite` are always allowed; `Task`
always asks, because a subagent can edit files on its own. Deny rules beat
allow rules, so a narrow `allow` cannot punch a hole in a broad `deny`.
`additionalDirectories` is accepted for Claude Code compatibility, but paths
are not sandboxed — see Limitations.

## Settings, memory and commands

Settings are merged in this order, later files winning:

1. `~/.deepseek-code/config.json` (user defaults)
2. `<project>/.claude/settings.json` (Claude Code compatible)
3. `<project>/.claude/settings.local.json`
4. `<project>/.deepseek-code/settings.json`
5. `<project>/.deepseek-code/settings.local.json`
6. environment variables and CLI flags

Environment variables: `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`,
`DEEPSEEK_MODEL`, `DEEPSEEK_SMALL_MODEL`, `DEEPSEEK_MAX_TOKENS`,
`DEEPSEEK_MAX_STEPS`, `DEEPSEEK_THINKING`, `DEEPSEEK_EFFORT` and
`DEEPSEEK_PERMISSION_MODE`.

The system prompt is built from a user memory file (`~/.claude/CLAUDE.md` or
`~/.deepseek-code/CLAUDE.md`), the project memory file (`CLAUDE.md`, then
`AGENTS.md`, then `CLAUDE.local.md`) and an environment block. Memory files can
pull in more context with `@relative/path` imports.

Custom slash commands live in `.claude/commands/*.md` and are invoked as
`/name`. Front matter supports `description`, `argument-hint`, `allowed-tools`
and `model`; the body expands `$ARGUMENTS`, `$1`–`$9` and `$ARGUMENTS[0]`.


## Slash commands

| Command | What it does |
| --- | --- |
| `/help` | list the built-in commands and this project's custom ones |
| `/init` | write a starter `CLAUDE.md` describing the repository |
| `/memory` | show which memory files were loaded |
| `/status` | session id, model, permission mode, cwd |
| `/cost` | tokens, cache hit rate and estimated USD spend |
| `/todos` | reprint the current task list |
| `/model [name]` | show or switch the model |
| `/mode [mode]` | show or switch the permission mode |
| `/compact` | summarise older turns to free up context |
| `/clear` | start a fresh conversation |
| `/resume` | pick a saved session for this directory |
| `/exit`, `/quit` | leave (Ctrl-C twice also works) |

## Sessions

Each turn is appended to a transcript under
`~/.deepseek-code/projects/<slug-of-cwd>/<session-id>.json`. Come back to one
with `-c`, `-r`, `-r <id>`, `/resume`, or list them with
`deepseek-code sessions`. When a conversation grows past the model's context
window, older turns are compacted into a summary automatically; `/compact` does
the same on demand.

## Cost tracking

`/cost`, `--verbose` and the JSON output report token usage and a cost
estimate. Cache hits, cache misses and output tokens are priced separately with
DeepSeek's published rates (peak and off-peak), so a long session with good
prompt caching shows a realistic number rather than a guess.

## DeepSeek specifics handled here

- **Thinking mode** is on by default (`thinking: {type: "enabled"}` plus
  `reasoning_effort`); `--no-thinking` disables it.
- The chain of thought arrives separately as `reasoning_content`, is rendered
  dimmed, and is **echoed back on every later request** — DeepSeek loses the
  chain of thought if assistant messages are replayed without it.
- `temperature`, `presence_penalty` and `frequency_penalty` are not sent,
  because thinking mode ignores them.
- Retries with exponential backoff on `408/409/429/5xx` and network errors,
  honouring `Retry-After`. A retry never happens after tokens have reached your
  terminal, so an answer is never printed twice.
- `401` (bad key) and `402` (insufficient balance) produce actionable messages
  instead of a raw HTTP dump.

## Project layout

```
bin/deepseek-code.js   CLI entry point, flags, REPL, slash commands
src/agent.js           the agent loop, subagents, compaction
src/api.js             streaming client for /chat/completions
src/tools/             fs, search, shell, misc and Task tools
src/permissions.js     rules, matching and the four modes
src/prompt.js          system prompt and memory files
src/config.js          settings files, env vars, precedence
src/session.js         transcripts and resume
src/commands.js        slash commands and custom .md commands
src/ui.js              colours, line reader, renderers
src/diff.js            unified diff for edit previews
src/cost.js            token accounting and pricing
test/                  node:test suites
  helpers/mock-api.js  stub OpenAI-compatible server
  helpers/fake-tty.mjs runs the CLI with stdin/stdout faking a terminal
```

## Tests

```bash
npm test          # 48 cases, a couple of seconds, no API key required
```

`scripts/test.mjs` collects `test/*.test.js` and hands the explicit paths to
`node --test`, so the same command works on Node 18 through 24 and on Windows,
where neither shell globbing nor the newer `--test` glob and directory handling
can be relied on.

The suites need no API key: `test/helpers/mock-api.js` starts a stub
OpenAI-compatible server on an ephemeral port, so the tests cover the real
streaming parser, tool dispatch, permission prompts, retry behaviour and
transcript persistence end to end.

`test/cli.test.js` is the black-box layer: it spawns the real
`bin/deepseek-code.js` as a child process (its own `HOME`, so nothing touches
your `~/.deepseek-code`) and checks that a one-shot run exits instead of waiting
on stdin, that tools are denied without a prompt, that `--resume`/`-c` replay an
earlier transcript, and — through `test/helpers/fake-tty.mjs` — that the REPL
prompts for approval and persists an "always allow" rule.

## Limitations

- No MCP client, no hooks, no image input, no background task manager, no GUI.
- File tools are **not sandboxed**: any path your user can reach is fair game,
  and approval is the only guard. Run it in a container or a worktree if that
  matters, or stay in `plan` mode for read-only research.
- `/compact` uses a second model call, so it costs tokens; automatic compaction
  only kicks in when the context is nearly full.
- `WebFetch` reads one page at a time and converts HTML to plain text.
- Rate limits and balance are your account's; `doctor` is the fastest way to
  tell an auth problem from a local one.

## Releasing

1. Bump `version` in `package.json` and add the matching `CHANGELOG.md` entry.
2. Commit, tag and push:

   ```bash
   git tag v0.1.1
   git push origin v0.1.1
   ```

`.github/workflows/release.yml` then runs `npm test`, builds the installable
`.tgz` with `npm pack` and attaches it to a new GitHub release with generated
notes. The `scripts/install.*` helpers always install whatever the newest
release carries, so that tarball is the only artifact anyone has to download.

Publishing to npm stays off until a repository secret named `NPM_TOKEN` (a
granular npm token with publish rights) exists; with it set, the same job runs
`npm publish --access public --provenance`.

## Licence

MIT — see [LICENSE](LICENSE). DeepSeek's own terms and pricing apply to your API
usage.
