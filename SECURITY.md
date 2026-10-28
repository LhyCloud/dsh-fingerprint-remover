# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | yes |

## Reporting a vulnerability

Open a private security advisory on GitHub:
<https://github.com/LhyCloud/dsh-fingerprint-remover/security/advisories/new>

Do not open a public issue for a bypass that exposes credentials or user data.
Include the dsh version, plugin version, the upstream error body, and a
minimal sanitized request. Remove API keys, cookies, and session identifiers.

## Scope

This plugin only rewrites outbound prompt text and request headers. It does not
store, transmit, or log credentials. `dumpPath` is opt-in and writes a local
JSON snapshot that may contain prompt text; treat that file as sensitive.
