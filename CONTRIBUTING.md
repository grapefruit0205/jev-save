# Contributing

```bash
git clone https://github.com/grapefruit0205/jev-save && cd jev-save
npm test                                  # node:test with a fake Jev; no API key needed
jev-save key "…" && node src/cli.js check Bash '{"command":"pytest -q"}'   # one live round trip
```

Rules that keep the project small:

- No runtime dependencies. Vendor a function with its source and license noted in a comment rather than adding a package.
- Code owns every threshold, timeout, cap and loop guard; Jev answers narrow typed questions. Policy functions stay pure so they run in tests without the API.
- Nothing that is not observed becomes evidence. An action the hooks did not see is `unknown`, and `unknown` never counts as "still valid".
- Shadow first. A new judgment ships in shadow mode with a way to score it before it can block anything.
- Never log or print an API key.

Upstream: this is a fork of [leepokai/jev-guard](https://github.com/leepokai/jev-guard); `git remote add upstream https://github.com/leepokai/jev-guard.git` and merge when its adapters or Jev client move. Files under `src/` that are unchanged from upstream should stay unchanged so merges stay cheap.
