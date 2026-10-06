# bb-kilocode

First-class Kilo Code provider for [BB](https://github.com/get-bb/bb).

This plugin talks to Kilo Code as provider id `kilocode`, shown in the picker as **Kilo Code**.

## What you can do

- Pick **Kilo Code** and use it in BB threads.
- Model picker lists providers you already authenticated in Kilo Code.
- Thread context meter (tokens vs window).
- Agent chip: `build` / `plan` / `orchestrator` and other listed primaries.
- BB's `/` picker reads Kilo Code commands.
- `/compact` or `/summarize` compacts.
- Modes: Accept edits / Approve for me / Full access.
- Allow / Deny / Always on BB's card for bash, file edits, and other tools.
- Streaming text and thinking. Live bash. File reads, edits/diffs, search/glob, web search/fetch.
- Native **Fork** (checkpoint) and **Edit** (resend from that turn).
- Import sessions from Kilo Code.
- `bb kilocode status|version|logs|commands [directory]` CLI commands.

## Requirements

- BB `>=0.39` / plugin SDK `>=0.4.16`
- Kilo Code installed and authenticated on the enrolled host.

## Install

```sh
npm install
bb plugin install .
```

## Update

For the local-path install above:

```sh
git pull --ff-only
npm install
bb plugin build
bb plugin reload kilocode
```

If you installed from a tracking Git URL instead, run `bb plugin update kilocode`.

## Operator commands

```sh
bb kilocode status
bb kilocode version
bb kilocode logs
bb kilocode commands [directory]
```

## Layout

`server.ts` declares the provider. `host.ts` owns the SDK, detached process, and `thread/delta` bridge. `app.tsx` is slots + RPC only.
