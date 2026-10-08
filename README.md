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
- **Fork** — `bb thread fork` works both ways: from a checkpoint (the fork
  starts at that turn, with the history before it retained) and at the tip
  (`session/fork`, Kilo's own clone).
- **Edit** — `bb thread edit-message` works on **any** message: the edited
  turn is rebuilt from the checkpoint before it, with every earlier message
  carried over as real prior context, and the turns after the edited one are
  re-run from there. Editing the first message needs no checkpoint at all (BB
  restarts the session). What is never replayed blind is a history the plugin
  could not confirm — see *Editing earlier messages, rewind, and forks* below.
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
  Kilo Code's version rather than the launcher's). It also performs the two
  checkpoint interceptions described below: stamping outgoing turn
  boundaries and staging a rewind.
- `adapter/acp.mjs` spawns `kilo acp` and forwards every JSON-RPC line
  byte-for-byte in both directions, so Kilo Code's own capabilities (fork,
  resume, model options, streaming, tool calls) reach BB unmodified. On top
  of that passthrough it only *observes* traffic — to publish checkpoint
  counts — and answers exactly one request itself, the `session/fork` of a
  staged rewind that Kilo's tip-only clone could never run.

The CLI's HTTP mode (`kilo serve`) is deliberately not used: ACP over stdio is
the CLI's native control surface, and it needs no port, no client SDK, and no
retry loop.

## Editing earlier messages, rewind, and forks (checkpoints)

Kilo's ACP `session/fork` clones a session only at its tip — there is no head
parameter — so rewinding to an earlier turn is rebuilt from Kilo Code's own
store instead. Three pieces cooperate over one registry: a directory of JSON
records, one file per id, under `BB_KILO_STATE_DIR` (default
`$TMPDIR/bb-kilo-state`).

1. **Publish** (`adapter/acp.mjs`) — on `session/new`, on prompt arrival, when
   a prompt settles, and on `session/load`/`session/fork`, the adapter counts
   the session's `role:"user"` messages in Kilo's own store
   (`~/.local/share/kilo/kilo.db`) and writes a live record under both the
   session id and the bb thread id:
   `{kind:"live", sessionId, bbThreadId, cwd, userCount, seeded, updatedAt}`.
   The count is taken with the same definition `kilo export` truncation uses,
   so a checkpoint can never cut a different set of messages than the one it
   was counted from.
2. **Stamp** (`host.ts`) — the settled recount runs *before* the prompt
   response is forwarded, i.e. before BB's bridge emits that turn's
   `thread/delta` `turn.boundary`; host.ts attaches
   `providerCheckpointId = "<sessionId>#<userCount>"` to every boundary that
   does not carry one already. It also rewrites the bridge's hardcoded
   `fork: "tip"` handshake result to `checkpoint` — BB takes the minimum of
   the registration and the handshake, and its rewind preparation throws
   below `checkpoint`.
3. **Rewind** (`host.ts` → `adapter/acp.mjs`) — BB's rewind preparation sends
   `thread/fork` with `sourceProviderCheckpointId` and a staging thread id
   containing `:rewind:`. host.ts resolves the checkpoint against the
   registry, writes a staged record (`{kind:"staged", sourceSessionId,
   truncateTo, requestThreadId, createdAt}`) and answers the prepare directly
   with `{providerThreadId: stagedId}` — no staging session is ever started.
   When BB starts the replacement thread, that staged id arrives here as
   `session/fork`, and the adapter answers it: `kilo export` → truncate to the
   checkpoint's count → rewrite every id (session, messages, parts, and the
   `parentID` chain, dropping a parent that fell outside the kept prefix) →
   `kilo import` into the target directory → `session/load` the clone into our
   own `kilo acp` child → respond with the new session id. Only then is the
   staged record deleted, so a failed rebuild consumes nothing and can be
   retried (or cleaned up by `thread/discard` if the edit is abandoned).

`server.ts` pins `BB_KILO_STATE_DIR` into the launch spec's env, so the
adapter inherits it, and `host.ts` reads the same value back from any request
that carries the launch spec; both sides fall back to the same default when
the variable is absent.

**The honest fallback.** A count the store could not confirm publishes
`seeded:false`, and a `seeded:false` record stamps no checkpoint: BB then
answers its own *"This earlier provider turn has no editable history
checkpoint"* instead of truncating history against a guess. A checkpoint whose
registry record is gone (state dir cleared) is refused with the same error
code and a message that says so — *"The Kilo Code session registry has no
record of checkpoint …"* — rather than blaming fork support. Either way the
refusal happens before the provider is touched: nothing is replayed, and
nothing is reported as edited that did not happen.

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
- **Message edits** — `bb thread edit-message` runs on any message, rebuilding
  the turn from the checkpoint before it with the earlier history retained
  (see the checkpoint section above). Two refusals stay honest: a count Kilo's
  store never confirmed publishes no checkpoint (`seeded:false`), so BB answers
  *"This earlier provider turn has no editable history checkpoint"* itself;
  and a checkpoint whose registry record is gone is refused by this plugin
  with the same code and a message naming the missing record. Both happen
  before the provider is touched — nothing is cut against a guess, nothing is
  replayed, and nothing is reported as edited that did not happen. The
  rebuild exports and re-imports the whole transcript, so editing a turn on a
  very large session takes a few seconds rather than an instant.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # bb plugin build → dist/
```

Tests cover the registration contract (including the `fork` value behind
BB's edit-message gate and the launch env carrying `BB_KILO_STATE_DIR`), the
`provider/health` and `provider/usage` answers, Kilo Code branding, the
checkpoint registry and its outgoing rewrites (handshake upgrade, boundary
stamping, `seeded:false` gating), the rewind primitive (`kilo export` →
truncate → re-id, id chains and dangling parents included), and the adapter
proxy driven end to end against a fake `kilo` (initialize, session, prompts,
checkpoint publishing and seeding, the staged rewind rebuild, an honest
failure path) — including that a run of turns leaves no usage ledger behind.

## License

MIT
