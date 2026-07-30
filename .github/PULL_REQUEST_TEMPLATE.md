<!--
Thanks for contributing to seismo-cc. Keep the engine dependency-free and the
gate deterministic. See CONTRIBUTING.md.
-->

## What this changes

<!-- One or two sentences. -->

## Why

<!-- The problem it solves. Link the issue if there is one (Closes #…). -->

## Type

- [ ] Bug fix
- [ ] New signal / feature
- [ ] Docs only
- [ ] Refactor / internal

## Checklist

- [ ] `./test/smoke.sh` passes locally (and I added/updated a test if behavior changed)
- [ ] **No new runtime dependency** — still runs on Node 18+ with no `npm install`
- [ ] Any new advisory signal does **not** affect `risk.level` or the gate (stays deterministic)
- [ ] Docs updated where relevant (`README.md`, `docs/`, `CHANGELOG.md`)
- [ ] Everything is in **English**, no domain-specific / private identifiers in examples

## Notes for the reviewer

<!-- Anything worth flagging: a design trade-off, a known limitation, a follow-up. -->
