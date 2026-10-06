# bb-kilocode

Kilo Code as a native [BB](https://github.com/get-bb/bb) provider.

Install it and **Kilo Code** shows up in BB's provider picker as provider id
`kilocode`. Threads run against the installed `kilo` CLI over the Agent Client
Protocol — the same session, tools, and model catalog you get from
`kilo` in a terminal.

## Requirements

- BB `>= 0.45` (plugin SDK `>= 0.6.15`, installed with the plugin).
- The Kilo Code CLI on the machine that runs the thread, executable as `kilo`
  (or named with `KILO_BIN`).
- Sign-in only for the models that need it: `kilo/kilo-auto/free` runs with no
  credentials, everything else needs `kilo auth login` first.

## Install

```sh
bb plugin install git:https://github.com/masked8knights/bb-kilocode.git@main --yes
```

Then reload BB (or `bb plugin reload kilocode`) and pick **Kilo Code** in a
thread.

Working on the plugin itself:

```sh
git clone https://github.com/masked8knights/bb-kilocode.git
cd bb-kilocode
npm install
npm run build
bb plugin install . --yes
```

After editing an installed checkout:

```sh
git pull --ff-only
npm install
npm run build
bb plugin reload kilocode
```

## Usage

- **Provider** — *Kilo Code* in the thread's provider picker. Threads, forks,
  and edits behave like any other BB provider.
- **Models** — the picker opens on Kilo's own router (`kilo-auto/free` is the
  default), with the rest of the 300+ model catalog behind "more models". The
  choice is applied to the session through Kilo's own model option, so the
  terminal and BB agree.
- **Permissions** — Accept edits / Full access. Tool approvals still arrive as
  BB cards.
- **Fork** — tip forks work (`session/fork`); rewind to a checkpoint does not.
- **Sign in** — `kilo auth login` on the machine running the thread.

```sh
KILO_BIN=/opt/kilo/bin/kilo bb plugin reload kilocode   # non-default CLI path
bb plugin logs kilocode                                  # adapter + registration log
```

### Usage ledger

Every settled turn appends one line to `~/.kilocode/usage.jsonl`
(`KILO_USAGE_FILE` overrides the path):

```json
{"kind":"generation","fact":{"provider":"kilocode","model":"kilo-auto/free","created_at_ms":1770000000000,"input_tokens":10926,"cache_read_tokens":2048,"output_tokens":44,"total_cost":null,"cwd":"/home/you/project","session_id":"ses_..."}}
```

Numbers come from the ACP prompt result, not an estimate. `total_cost` is the
session-cumulative cost the turn added and stays `null` while the CLI reports
zero — Kilo's free tier reports no spend, and null is more honest than an
invented price. The file is written only by this plugin; nothing in it leaves
the machine.

## How it works

```
BB ── ACP (stdio) ──> adapter/acp.mjs ── ACP (stdio) ──> kilo acp
                          │
                          └── appends one generation fact per turn
```

- `server.ts` registers `kilocode` and declares the launch spec: the generic
  ACP dialect, `adapter/acp.mjs` as the command, and the primary model group.
- `host.ts` re-exports BB's published ACP bridge, so the `bb.host` artifact BB
  ships to hosts runs that bridge.
- `adapter/acp.mjs` spawns `kilo acp` and forwards every JSON-RPC line
  byte-for-byte in both directions. It observes — never translates — the
  traffic, so Kilo Code's own capabilities (fork, resume, model options,
  streaming, tool calls) reach BB unmodified.

The CLI's HTTP mode (`kilo serve`) is deliberately not used: ACP over stdio is
the CLI's native control surface, and it needs no port, no client SDK, and no
retry loop.

## Honest limits

- **Health** — BB's `provider/health` probes the launch command. That command
  is the adapter, whose `--version` forwards to `kilo --version`, so a machine
  with Kilo Code reports `7.8.3`. On a checkout that lost its executable bit
  the adapter is launched as `node <adapter>`, and the probe then reads Node's
  version instead. If `kilo` disappears after install, health still says ready
  while turns fail with the CLI-missing message.
- **Usage windows** — Kilo Code publishes no quota endpoint, so
  `provider/usage` honestly answers "unsupported"; the local journal above is
  the usage story.
- **Compaction** — `/compact` reaches Kilo Code as an ordinary prompt and does
  not compact, so the manual-compact affordance stays off.
- **Plan mode** — Kilo Code's `plan` session mode is not wired to BB's plan
  composer action; the action is not advertised rather than advertised and
  inert.
- **Reasoning level** — Kilo Code's ACP session exposes a single Effort value
  (`thinking`), so the picker offers one rung instead of a ladder it cannot
  honor.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # bb plugin build → dist/
```

Tests cover the registration contract, the usage mapping, and the adapter
proxy driven end to end against a fake `kilo` (`--version`, initialize,
session, two prompts, journal).

## License

MIT
