# Contributing

Thanks for helping keep the fingerprint list accurate.

## Development

```bash
git clone https://github.com/basaltfold/dsh-fingerprint-remover.git
cd dsh-fingerprint-remover
npm test
```

Requires Node.js 20 or newer. There are no runtime or development dependencies.

## Adding a rule

Every rule must be anchored to a **confirmed** upstream fingerprint. Include in
the pull request:

1. the exact text or header that triggers `400 / code 11-128`;
2. an A/B result showing the baseline passes and the rewrite passes;
3. a regression test in `test/`.

Rules live in `lib/sanitize.js`. Prefer the narrowest anchor that still matches:
rewriting a whole paragraph usually changes more than necessary.

## Code style

- ES modules, no dependencies.
- `npm run check` must pass (`node --check` plus the test suite).
- Keep sanitizers pure; the fetch interceptor is the only I/O boundary.

## Reporting a bypass

Open an issue with:

- dsh version and plugin version;
- the upstream error body;
- `/fingerprint scan` output (provider/model and `before -> after`);
- the smallest sanitized request that still fails, with secrets removed.

Do not paste API keys, cookies, or full session logs.
