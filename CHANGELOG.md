# Changelog

## 1.0.0 鈥?2026-10-28

First release under the publishable name **dsh-fingerprint-remover**
(previously `dsh-workbuddy-stealth`).

### Added

- GitHub-ready package layout: `README.md`, `README.zh-CN.md`, `CHANGELOG.md`,
  `LICENSE`, `.gitignore`, and a CI workflow.
- `dsh.install` metadata (tarball / zip / git) and repository/homepage/bugs
  fields.
- `/fingerprint scan` and the loopback `GET /dsh-fingerprint-remover` status
  route, including a `before -> after` fingerprint count for the last real
  request.

### Changed

- Package, plugin id, route, command, logger prefix, and symbol keys renamed
  from `dsh-workbuddy-stealth` / `/stealth` to `dsh-fingerprint-remover` /
  `/fingerprint`.
- Version reset to `1.0.0` for the first public release.

### Fixed

- **Reference-rules sentence pair.** The upstream `11-128` check matches two
  consecutive sentences as one contiguous run. Rewriting the first sentence
  breaks the match; the plugin now paraphrases the first and rewrites the
  second. A/B matrix in `README.md`.

## 0.3.0 鈥?2026-10-28

### Fixed

- The reference-rules sentence pair at the top of the system prompt:
  `An @ prefix marks a path the user named explicitly.` followed by
  `Relative paths are resolved against the workspace root, while absolute paths
  refer to files or directories on the machine.` is rejected as one contiguous
  fingerprint. Both sentences are now rewritten.

### Added

- `referenceRulesReplacement` and `hostRuleReplacement` config overrides.
- Regression tests for the pair and for paragraph semantics.

## 0.2.0 鈥?2026-10-28

### Fixed

- Final outbound JSON body scrubbing: replayed history, runtime-context
  snapshots, reasoning blocks, `tool_calls` arguments, tool descriptions, and
  parameter descriptions. The adapter's `options` object is frozen, so the
  boundary moved to `globalThis.fetch`.

### Added

- `sanitizeToolResults` and `sanitizeUserMessages` switches.
- `/stealth scan` (now `/fingerprint scan`) and the loopback status route.

## 0.1.0 鈥?2026-10-27

### Added

- Initial release: assembly-time prompt sanitizer, attribution User-Agent
  rewrite, and `x-dsh-*` header removal.

## License

MIT
