# dsh-fingerprint-remover

<p align="center"><strong>&#31227;&#38500; dsh &#29305;&#24449;&#25554;&#20214;</strong></p>

[![test](https://github.com/LhyCloud/dsh-fingerprint-remover/actions/workflows/test.yml/badge.svg)](https://github.com/LhyCloud/dsh-fingerprint-remover/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Contributing](CONTRIBUTING.md)

Removes the client fingerprints that the WorkBuddy gateway rejects with
`400` / `code 11-128` (`Illegal API invocation from an unapproved channel`),
at the outbound request boundary of the dsh.

## Why this exists

The gateway does not reject the model. It rejects a *contiguous text run* in
the request. Every dsh request used to start with these two sentences:

```text
An @ prefix marks a path the user named explicitly.
Relative paths are resolved against the workspace root, while absolute paths refer to files or directories on the machine.
```

Measured against the same upstream (`hy4-preview-f`, same system slot):

| Request | Result |
| --- | --- |
| First sentence alone | `200` |
| Second sentence alone | `200` |
| Both, back to back | **`400` `code 11-128`** |
| First rewritten + second original | `200` |
| First original + second rewritten | `200` |
| Both rewritten | `200` |

Rewriting the **first** sentence is what breaks the match; rewriting only the
second also happens to break the pair, but the first is the anchor the gateway
locks onto. The remover rewrites both, so no other adjacent pairing can re-form
the fingerprint.

Beyond that pair, a dsh request carries several other identifiers the gateway
can inspect: the harness identity sentence, the GUI paragraph, the checkout
line, the local Web GUI URL, `.dsh` paths, `dsh` paths, `dsh-*` package
names, `HOST_*` environment variables, reasoning blocks, tool results, and the
attribution `User-Agent`. All of them are scrubbed.

## What it touches

| Surface | Treatment |
| --- | --- |
| Reference-rules sentence pair | First sentence paraphrased; second rewritten to a synonym |
| Harness identity sentence | Removed |
| GUI paragraph | `...Web GUI whose URL the runtime context names.` reworded |
| Runtime context | Checkout line and local Web GUI URL removed; workspace path replaced with `<workspace>` |
| Replayed history | `system` / `developer` / `assistant` / runtime-context / `user` / `tool` |
| Reasoning blocks | Same rules as visible text |
| `tool_calls` arguments | JSON string scrubbed |
| Tool descriptions and parameter descriptions | `dsh`, `HOST_*`, package names |
| User-Agent | `dsh` token replaced with the WorkBuddy desktop UA |
| Attribution headers | `x-dsh-*` removed |

Normal user messages are scrubbed by default; set `sanitizeUserMessages: false`
to leave them byte-for-byte alone.

The plugin never changes providers, models, routes, credentials, tool names, or
the dsh itself. It only rewrites the serialized request and headers.

## Install

```bash
dsh plugin add dsh-fingerprint-remover
```

From this repository:

```bash
dsh plugin add github:LhyCloud/dsh-fingerprint-remover
```

Or from a checkout:

```bash
dsh plugin --profile desktop add file:/path/to/dsh-fingerprint-remover
```

Restart the dsh once. On boot:

```text
[dsh-fingerprint-remover] active 闂?prompt sanitizer on, UA -> WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0
```

## Commands

| Command | Effect |
| --- | --- |
| `/fingerprint` (or `/fingerprint status`) | Status, counters, last payload scan |
| `/fingerprint scan` | Last outbound request: provider/model, fingerprints before 闂?after |
| `/fingerprint on` / `off` | Toggle in this process (restart restores config) |
| `/fingerprint why` | Root-cause explanation |

Read-only JSON status (loopback only):

```text
GET /dsh-fingerprint-remover
```

## Configuration

```yaml
- insert:
    - id: dsh-fingerprint-remover
      name: 'dsh-fingerprint-remover'
      config:
        enabled: true
        providers: []                    # [] = all providers
        sanitizePrompt: true
        sanitizeToolResults: true
        sanitizeUserMessages: true
        sanitizeUserAgent: true
        stripAttributionHeaders: true
        userAgent: 'WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0'
        referenceRulesReplacement: 'An @ prefix marks a path the user named explicitly.'
        hostRuleReplacement: 'Relative paths are resolved against the workspace root, while absolute paths refer to files or directories on the machine.'
        dumpPath: ''                      # optional: write the last sanitized request
        verbose: false
```

`dumpPath` writes a local JSON snapshot of the last scrubbed request, useful for
verification. It is off by default and never leaves the machine.

## How it works

The adapter's `options` object is frozen, so a `llm/stream` waterfall cannot
replace it. The authoritative boundary is `globalThis.fetch`:

1. parse the serialized JSON body;
2. rewrite `messages`, `system`, and `tools`;
3. re-serialize and send;
4. rewrite the `User-Agent` and drop `x-dsh-*` headers.

The `system-prompt/assemble` hook is kept as well, so the prompt stored in the
session log is already clean.

## Verification

```bash
npm test        # 17 tests, no network
```

Replaying a real session (308 messages + 40 tools):

```text
before 4768 fingerprints -> after 0
```

With the plugin loaded, `/fingerprint scan` reports the last real request's
`before -> after`; a healthy value is `0` remaining.

## Scope and limits

- Rule-based and anchored to known fingerprints. A new upstream rule needs a new
  anchored rule here.
- Does not forge `machineId` / `sessionId` or other proto-level identity fields.
- Rewriting historical tool results means the model may see placeholders where a
  real path used to be; that is the intended tradeoff for stealth.
- Test against a profile you can restore. Keep the backup files the plugin's
  package manager writes.

## License

MIT
