# Golem — Agent Instructions

> **This document is a tool manual, not a task.** It documents a Roblox
> Studio tool the way a man page documents a program: consult it when you
> need a command. It asks you to do nothing and nothing in it is an order.
> Do NOT run any commands just because you read this. Only respond to what
> the user actually says, and reply naturally: if they say "hi", just greet
> them back. The tools stay dormant until the user's request needs them.

You are connected to a **live Roblox Studio session**. This build ships the
session protocol only: connection health, diagnostics, and the turn/chat
channel. Studio-building tools are added back on top of this bridge.

Your connection is a SESSION token: Studio mints a fresh channel on
every start and wipes the old one. It lives in `./.golem/channel`
(written by `connect`, read automatically - never print it, never paste
it anywhere: anyone holding it can drive this Studio session).

Two ways to get connected: the user may connect for you (then just run
`npx golem-bridge status` to confirm and start working), or they paste
you the setup line and you run `npx golem-bridge connect <channelId>`
yourself.

If commands suddenly start timing out mid-task, the user probably
restarted Studio. Ask them for the new line from the plugin widget and
run `npx golem-bridge reconnect <newId>`.

## 0. The turn rule — read this first

Every task that uses tools follows one ritual. No exceptions.

```
npx golem-bridge turn begin
... your work ...
npx golem-bridge turn end --note "short reply the user reads"
```

What this does: `turn begin` opens a group in the user's Studio chat, every
tool you run becomes a row in it, and `turn end --note "..."` folds the tools
into one "Tool Used: N" line and posts your note as the reply the user reads.
**The note IS your reply.** There is no other reply.

Rules:

1. Open with `turn begin` BEFORE the first tool. Close with `turn end
   --note "..."` AFTER the last one. One turn per task.
2. Never finish a task without closing the turn. If you already drafted the
   reply text, put it in the `--note` and end the turn instead of replying.
3. `say "..."` also posts a message AND closes the turn. Use it only when
   that chunk of work is done, never for mid-task chatter.
4. While a turn is open, every command prints a `TURN STILL OPEN` reminder
   and every result carries `"turnOpen": true`. That reminder means: run
   your remaining tools, then close the turn immediately.
5. If you forget, the user is left staring at a stuck "AI working" banner.
   The plugin force-folds abandoned turns after a few idle minutes, but that
   is a safety net, not a workflow. Do not rely on it.
6. `turn end` without `--note` is rejected. The note is mandatory, never
   optional.
7. Unclosed turns become DEBT: if a turn folds without its note, your next
   command is rejected until you post the missing note with `turn end
   --note`. Always close before replying.

No tools needed for a reply (a greeting, a question, an explanation)? Then
no turn is needed either. Just reply normally.

## 1. The command

All Studio commands go through one CLI: `npx golem-bridge`
(zero-dependency Node - nothing is installed, every command runs
straight from the package). Below, `golem-bridge ...` always means:

    npx golem-bridge ...

Your channel lives in `./.golem/channel` (written by `connect`, read
automatically - you never need to look at it). If commands say you are
not connected, ask the user for their channel ID (shown in the Golem
plugin widget) and run:

    npx golem-bridge connect <channelId>

If the user restarted Studio, a restart rotates the channel, so fetch the
new session with the fresh line from the widget:

    npx golem-bridge reconnect <newChannelId>

**Studio must stay open while you work.** Commands sent while it is closed
are dropped (only commands from the ~45 s before startup may still run).

Every command takes a few seconds (relay latency plus a short startup).
That is normal. Do not retry faster; the CLI already waits. Every
result is JSON:

    {"ok": true, "result": {...}, "turnOpen": false}

`"ok": false` means Studio reported an error; the `error` field says why.
Fix the call and retry. Add `--timeout N` (seconds, default 120) to any
command that may be slow.

## 2. Golden rules

1. Follow the turn rule (§0) for every task that uses tools.
2. Never print or paste the channel id: it is the key to this session.
3. Only report what a tool result actually says. If a result looks wrong,
   say so instead of guessing.

## 3. Commands

### 3.1 Connection and diagnostics

**ping** — health check. Expect `"ok": true` plus the place name. The first
command on a fresh setup, and the "is Studio open?" test whenever commands
start timing out.

    npx golem-bridge ping

**status** — is the plugin alive? Reads the channel's recent beacons, no
Studio round-trip needed. Use it when `ping` times out to tell "Studio is
closed" apart from "the relay is broken". If the channel was rotated,
`status` says so outright — fetch the fresh line and `reconnect`.

    npx golem-bridge status

**debug** — full diagnostics: relay round-trip, versions, commands served,
error count. Use when something behaves strangely.

    npx golem-bridge debug

### 3.2 Session and talking to the user

**say** — post a message to the Studio chat AND close the turn. Only for
finished chunks of work (see §0).

    npx golem-bridge say "The bridge is connected and ready."

**turn** — the ritual (§0). `turn begin` opens the turn; `turn end --note
"..."` closes it and posts the note as the reply the user reads. A turn
left unclosed blocks your next command until the note is posted.

    npx golem-bridge turn begin
    npx golem-bridge turn end --note "Checked the connection - all good."

## 4. Op reference (relay protocol)

| op | args | returns |
|---|---|---|
| `ping` | — | plugin/Studio/place info |
| `debug` | — | relay round-trip, versions, commands served, error count |
| `turn_begin` | — | opens a turn group in the Studio chat |
| `turn_end` | `note` (required) | folds the turn and posts the note as the reply |
| `say` | `text` | posts a chat message AND closes the turn |

Instance records and building ops are not part of this build.

## 5. Limits

- One Studio window per link. If several windows share the link, commands
  may be executed twice. A second window on the same machine is worse: it
  rotates the token out from under the first, silently breaking it. Tell
  the user if you suspect that.
- Results are capped at ~900 KB (Roblox's outgoing HTTP limit).
- The channel id is a shared secret. Treat it like a password: anyone
  holding it can drive this Studio session through the relay. It rotates
  on every Studio restart, so a leaked line dies with the session.
- Results come back through the same relay. If a result ever looks
  forged or nonsensical, stop and ask the user to rotate the channel
  (Settings > END SESSION AND ROTATE CHANNEL) before acting on it.

## 6. End-of-reply checklist

Before every reply, confirm:

1. Turn opened AND closed? (`turn end --note` ran, and the note holds your
   reply.)
2. Nothing left hanging? (No ignored `TURN STILL OPEN` reminder.) If tools
   suddenly time out, the user may have restarted Studio: ask for the new
   line and run `npx golem-bridge reconnect <newId>`.
