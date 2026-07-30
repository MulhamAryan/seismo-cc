# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Path-segment exclusion.** `ignored()` matched patterns as raw substrings, so
  legitimate paths were silently dropped from the scan (`routes/web.php` contains
  "out", `Distance.cs` contains "dist", `query_builder.php` contains "build") —
  including the public surface the tool claims to detect. Now matches on path
  segment boundaries.
- **Guard could be satisfied trivially.** Coverage no longer holds just because a
  file name appears in a fresh report. Each analysis records a SHA-1 content hash
  per in-scope file (`fileHashes`); the guard recomputes and refuses if the file
  changed since the analysis, so a stale-content report no longer lets an edit
  through.
- **`--json` output polluted.** The status line now goes to stderr in `--json`
  mode, leaving stdout as pure, parsable JSON.
- **Silent reference cap.** `references()` no longer caps the call-site count at 50
  without saying so; the displayed line list is bounded but the count is
  uncapped, and truncation plus total occurrences are surfaced.
- **Merge double-counting.** `git log -m` emits a merge commit once per parent;
  `parseLog` now deduplicates by SHA so historical-coupling counts are not
  inflated on merge-heavy histories.

### Added
- **.NET-focused resolution.** Ambiguous symbols (multiple declarations across
  namespaces) are detected and flagged instead of silently merged; namespace-aware
  `namespaceAt`; `stripNoise` handles C# verbatim (`@"…"`) and interpolated
  (`$"…{expr}…"`) strings and TypeScript template literals, keeping interpolation
  expressions while dropping literal text; C# declaration regexes now catch
  `private` methods, expression-bodied members and attributed methods.
- English throughout (report output, risk labels, CLI, hook messages, docs).

### Changed
- Risk-level values are now `low` / `moderate` / `high` / `blocking`.
- README documents per-stack support with .NET as the first-class target;
  PHP/Laravel, Kotlin and TypeScript are best-effort; git coupling is
  language-agnostic.

## [0.1.0]
- Initial engine (zero-dependency Node CLI), analyst subagent, impact-analysis
  skill, `/seismo-cc:impact` command, and `PreToolUse` guard.
