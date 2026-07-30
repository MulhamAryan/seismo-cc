---
name: Feature request
about: Suggest an improvement or a new signal
title: "[feat] "
labels: enhancement
---

## Problem

<!-- What are you trying to learn about a change that seismo-cc does not tell you today? -->

## Proposed idea

<!-- What should it do, and roughly how? -->

## Which signal / surface

<!-- Reference search · historical coupling · risk rules · hidden-dependency checks ·
indirect impact · a command (impact/tests/api-diff/brief/scope) · the MCP tools · the gate. -->

## Constraints to respect

The engine is **dependency-free and build-free** by design (Node 18+, no `npm install`),
and any advisory signal must **not** affect the deterministic risk/gate. Does your idea
fit those constraints? If it needs a build or runtime data, note it — see
[`docs/ROADMAP.md`](../../docs/ROADMAP.md) "Out of scope".

## Anything else

<!-- Links, prior art, example repos. -->
