# Security Policy

## Supported versions

seismo-cc is pre-1.0. Security fixes are applied to the latest `main` and the
most recent tagged release only.

| Version | Supported |
|---|---|
| latest `main` / newest release | ✅ |
| older releases | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately, either through GitHub's **[Private vulnerability reporting](https://github.com/MulhamAryan/seismo-cc/security/advisories/new)**
(Security → Report a vulnerability) or by email to **moulhamo@gmail.com**.

Please include:

- a description of the issue and its impact,
- steps to reproduce (a minimal repo or command is ideal),
- the affected version / commit,
- any suggested fix if you have one.

You can expect an acknowledgement within a few days. Once the issue is confirmed
and fixed, a release will be published and the report credited (unless you
prefer to stay anonymous). Please give a reasonable window for a fix before any
public disclosure.

## Scope and threat model

seismo-cc is a **read-only, zero-dependency** developer tool. It analyzes the
source tree it is pointed at and writes only under `.impact/`. Points worth
noting for the threat model:

- **It executes `git`** (via `child_process.execFile`, never a shell) to read
  history. It does not run project build scripts, install anything, or make
  network calls.
- **It reads source files** and applies regexes to their contents; a
  pathologically crafted file could in principle cause slow regex matching
  (ReDoS-style). Reports of such inputs are in scope.
- **The MCP server** (`seismo-impact`) speaks stdio JSON-RPC and performs the
  same read-only analysis; it opens no network port.
- Out of scope: vulnerabilities in the *analyzed* repositories themselves, and
  anything requiring an attacker to already control the machine running the CLI.
