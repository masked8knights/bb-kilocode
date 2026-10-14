# bb-kilocode

Kilo Code as a native [BB](https://github.com/get-bb/bb) provider.

Install it and **Kilo Code** shows up in BB's provider picker as provider id
`kilocode`. Threads run against the installed `kilo` CLI — the same account,
models, and session store you get from `kilo` in a terminal.

## Requirements

- BB `>= 0.45` (plugin SDK `0.6.37`, installed with the plugin).
- The Kilo Code CLI on the machine that runs the thread, executable as `kilo`
  (or named with `KILO_BIN`). Install: `curl -fsSL https://kilo.ai/cli/install | bash`.
- Sign-in only for the models that need it: `kilo/kilo-auto/free` runs with no
  credits, everything else may need `kilo auth login` and gateway credits.

## Install

```sh
bb plugin install git:https://github.com/masked8knights/bb-kilocode.git@self-provider --yes
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

- **Provider** — *Kilo Code* in the thread's provider picker.
- **Models** — the live catalog comes from `kilo models kilo --verbose`
  (300+ entries, refreshed from Kilo's gateway), opened on Kilo's own router
  (`kilo-auto/free` is the default). The pick is passed to each turn as
  `kilo run -m <provider/model>`.
- **Reasoning** — models that declare variants (low/medium/high/…) get an
  effort picker; the bridge passes the choice as `kilo run --variant <level>`.
- **Sessions** — each thread maps to one kilo session (`sessionID` from the
  first turn, persisted in the plugin host's temp dir). Later turns continue
  it with `kilo run --session <id>`, so history carries exactly like it does
  in the CLI.
- **Sign in** — `kilo auth login` on the machine running the thread.

```sh
KILO_BIN=/opt/kilo/bin/kilo bb plugin reload kilocode   # non-default CLI path
bb plugin logs kilocode                                  # registration log
bb kilocode status [--json]                              # provider + CLI probe
```

### Usage reporting

Kilo Code meters tokens, not accounts: there is no quota endpoint to call, so
BB's provider panel has no usage window to show for it. Per-turn token and
cost numbers are appended by the bridge to `~/.kilo-acp/usage.jsonl` (one
`kind:"generation"` record per settled step, the same shape the other
provider bridges write), and Kilo Code's own full history stays in
`~/.local/share/kilo/kilo.db`, which BB's usage collector reads directly.
Nothing leaves the machine.

## How it works

```
BB ── provider bridge (host.ts) ──> kilo run "<prompt>" -m <model> --format json [--session <id>]
```

- `server.ts` registers `kilocode` (models are host-scoped with the five
  `kilo-auto` tiers as fallback), resolves the `kilo` binary, and pushes
  `{kiloBin, model}` to the plugin host through the contract in `contract.ts`
  (a background reconciler retries on host changes and settings edits).
- `host.ts` is a self-contained provider bridge: it answers the model list
  from `kilo models kilo --verbose`, and runs each turn by spawning
  `kilo run --format json`, streaming `text` parts out as they complete and
  closing the turn from `step_finish` (tokens → usage ledger).

**Why not `kilo acp`?** Kilo's own stdio ACP server is broken upstream:
`session/prompt` never returns — no result, no `session/update`, for any model
([Kilo-Org/kilocode#10768](https://github.com/Kilo-Org/kilocode/issues/10768);
reproduced here on 7.8.8 and 7.8.9, Windows: the embedded ai-sdk runtime
stalls right after `llm runtime selected` while `kilo run` with the same
model answers in seconds). `kilo run` goes through a different code path and
is the reliable surface, so this plugin drives the provider through it.

## Honest limits

- **Fork / edit / rewind** — off (`fork: "none"`). `kilo run` has no session
  fork or history-truncation story; history continuity is `--session` only.
- **Tools and permissions** — a turn runs non-interactively inside Kilo Code.
  Its tool calls execute under Kilo's own agent permissions and are not
  surfaced as BB cards or streamed as BB tool items; the thread shows the
  assistant's text output. Keep that in mind before picking Full access on a
  repo you care about.
- **Steering** — messages sent mid-turn queue and run on the next turn
  (`steerMode: "queue"`); there is no live interrupt of a running `kilo run`
  beyond thread stop, which kills the child.
- **Health** — the plugin reports the resolved `kilo` binary (`KILO_BIN`, then
  `~/.kilo/bin/kilo[.exe]`, then `PATH`) and its `--version`. No installer is
  declared (`installation: false`): install or update Kilo Code yourself, then
  reload the plugin.
- **Compaction / plan mode** — not wired; the affordances stay off rather than
  advertised and inert.
- **Errors** — a failed `kilo run` (e.g. the gateway's "Add credits to
  continue, or switch to a free model") settles the turn as failed with the
  CLI's message; there is no retry loop.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # bb plugin build → dist/
```

Tests cover the registration contract (id, maintenance, env passthrough,
host-scope model fallbacks, capabilities) and the bridge surface asserted from
source (`kilo run --format json` + `--session`, no leftover `acpLaunchSpec`),
plus the maintenance/health helpers and Kilo Code branding.

## License

MIT
