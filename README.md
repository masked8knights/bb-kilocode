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

- **Provider** — *Kilo Code* in the thread's provider picker. Threads and
  forks behave like any other BB provider; edits are covered below.
- **Models** — the picker opens on Kilo's own router (`kilo-auto/free` is the
  default), with the rest of the 300+ model catalog behind "more models". The
  choice is applied to the session through Kilo's own model option, so the
  terminal and BB agree.
- **Permissions** — Accept edits / Full access. Tool approvals still arrive as
  BB cards.
- **Fork** — tip forks work (`session/fork`); rewind to a checkpoint does not.
- **Edit** — `bb thread edit-message` rebuilds the thread from the edited
  message: BB deletes the turn suffix and starts a fresh Kilo session
  carrying only the replacement prompt, so the history really is rebuilt
  rather than replayed. On a multi-turn thread the editable message is
  therefore the **first** one. Naming a later message with
  `--expected-request-sequence` is refused with *"This earlier provider turn
  has no editable history checkpoint"*; with no sequence BB edits the latest
  *eligible* message (its documented contract) — the first — and the turns
  after it go with it. Kilo's ACP layer clones a session only at its tip and
  this plugin publishes no `providerCheckpointId`, so there is no session
  state to rewind to the turn before an edit.
- **Sign in** — `kilo auth login` on the machine running the thread.

```sh
KILO_BIN=/opt/kilo/bin/kilo bb plugin reload kilocode   # non-default CLI path
bb plugin logs kilocode                                  # adapter + registration log
```

### Usage reporting

Kilo Code meters tokens, not accounts: there is no quota endpoint to call, so
BB's provider panel shows

```
Kilo Code does not expose account quota.
```

That answer comes from this plugin (`provider/usage`, see *How it works*), and
it is the whole usage story this plugin tells — it writes no ledger of its own.
Token and cost history lives in Kilo Code's own store
(`~/.local/share/kilo/kilo.db`), which BB's usage collector reads directly.
Nothing this plugin handles leaves the machine.

## How it works

```
BB ── ACP (stdio) ──> adapter/acp.mjs ── ACP (stdio) ──> kilo acp
```

- `server.ts` registers `kilocode` and declares the launch spec: the generic
  ACP dialect, `adapter/acp.mjs` as the command, and the primary model group.
- `host.ts` runs BB's published ACP bridge and answers the two sessionless
  maintenance probes itself: `provider/usage` (no quota API) and
  `provider/health` (the resolved `kilo` binary's own version, so BB shows
  Kilo Code's version rather than the launcher's).
- `adapter/acp.mjs` spawns `kilo acp` and forwards every JSON-RPC line
  byte-for-byte in both directions. It neither observes nor translates the
  traffic, so Kilo Code's own capabilities (fork, resume, model options,
  streaming, tool calls) reach BB unmodified.

The CLI's HTTP mode (`kilo serve`) is deliberately not used: ACP over stdio is
the CLI's native control surface, and it needs no port, no client SDK, and no
retry loop.

## Honest limits

- **Health** — `provider/health` resolves the same binary the adapter spawns
  (`KILO_BIN`, then `~/.kilo/bin/kilo`, then `PATH`) and asks it `--version`,
  so a machine with Kilo Code reports `7.8.3` whatever launches the adapter.
  The provider declares no installer (`installation: false`): install or
  update Kilo Code yourself, then reload the plugin.
- **Usage windows** — Kilo Code publishes no quota endpoint, so
  `provider/usage` answers that explicitly instead of inventing a number.
  See *Usage reporting* above.
- **Compaction** — `/compact` reaches Kilo Code as an ordinary prompt and does
  not compact, so the manual-compact affordance stays off.
- **Plan mode** — Kilo Code's `plan` session mode is not wired to BB's plan
  composer action; the action is not advertised rather than advertised and
  inert.
- **Reasoning level** — Kilo Code's ACP session exposes a single Effort value
  (`thinking`), so the picker offers one rung instead of a ladder it cannot
  honor.
- **Message edits** — the declaration says `fork: "checkpoint"`, which is the
  flag BB gates `bb thread edit-message` on, and the edit it can then run
  really does rebuild history: BB drops the turn suffix and starts a fresh
  Kilo session with only the replacement prompt. What cannot run is choosing
  a *later* message as the edit target — no `providerCheckpointId` is ever
  published and Kilo's ACP `session/fork` takes no head, so there is no
  session state to rewind to the turn before an edit. Naming such a message
  with `--expected-request-sequence` is refused by BB; without a sequence BB
  edits the latest eligible message, so on a multi-turn thread that is the
  first one and the turns after it are dropped. Every refusal happens before
  the provider is touched: nothing is replayed, and nothing is reported as
  edited that did not happen.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # bb plugin build → dist/
```

Tests cover the registration contract (including the `fork` value behind
BB's edit-message gate), the `provider/health` and `provider/usage` answers,
Kilo Code branding, and the adapter proxy driven end
to end against a fake `kilo` (`--version`, initialize, session, two prompts) —
including that a run of turns leaves no usage ledger behind.

## License

MIT
