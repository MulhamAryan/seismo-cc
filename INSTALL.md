# Installing seismo-cc

Every method below is zero-dependency: **Node 18+** and **git** are the only prerequisites. There is no `npm install`, no build, no service to host.

| You want to… | Go to |
|---|---|
| Use it inside Claude Code (the intended way) | [1. Claude Code — marketplace](#1-claude-code--marketplace-recommended) |
| Hack on it locally with Claude Code | [2. Claude Code — local plugin dir](#2-claude-code--local-plugin-dir-development) |
| Ship it inside your team's own catalog | [3. Claude Code — entry in another catalog](#3-claude-code--entry-in-another-catalog) |
| Run the engine from the shell / CI | [4. Standalone CLI](#4-standalone-cli) |
| Call it as an MCP server | [5. MCP server](#5-mcp-server-seismo-impact) |
| Tune it for one repo | [6. Per-repo configuration](#6-per-repo-configuration) |

---

## 1. Claude Code — marketplace (recommended)

The repository **is** a Claude Code marketplace: it ships `.claude-plugin/marketplace.json` at its root. You add the marketplace, then install the plugin from it — two lines, inside Claude Code:

```
/plugin marketplace add MulhamAryan/seismo-cc
/plugin install seismo-cc@seismo-cc
```

- `MulhamAryan/seismo-cc` is the GitHub `owner/repo` of the marketplace.
- `seismo-cc@seismo-cc` reads as `<plugin>@<marketplace>` — both happen to be named `seismo-cc`.

Once installed, **everything activates on its own** — nothing else to wire:

| Component | What it does |
|---|---|
| `impact-analysis` skill | tells the main agent when to analyze and what to do with the verdict |
| `impact-analyst` subagent | runs the analysis read-only, in its own context |
| `/seismo-cc:impact` · `/seismo-cc:tests` · `/seismo-cc:api-diff` · `/seismo-cc:brief` commands | manual invocation — full scope / affected tests only / breaking public-surface changes only / business impact brief for analysts & PMs |
| `seismo-impact` MCP server | the four typed impact tools |
| `PreToolUse` guard | refuses an `Edit`/`Write` without a fresh report |

**Update / remove:**

```
/plugin update seismo-cc@seismo-cc
/plugin uninstall seismo-cc@seismo-cc
/plugin marketplace remove seismo-cc
```

The repo is **private**: the account running Claude Code must have access to `MulhamAryan/seismo-cc` (be the owner or a collaborator), and `git` must be able to authenticate to GitHub (HTTPS credential or SSH key).

---

## 2. Claude Code — local plugin dir (development)

For hacking on the plugin itself. Clone, then point Claude Code at the working copy:

```bash
git clone https://github.com/MulhamAryan/seismo-cc.git
claude --plugin-dir ./seismo-cc
```

After editing a component **other than a `SKILL.md`**, reload without restarting:

```
/reload-plugins
```

This loads directly from disk — no marketplace resolution — so your uncommitted changes are live.

---

## 3. Claude Code — entry in another catalog

To distribute seismo-cc inside a *different* marketplace repo (e.g. a company-wide plugin catalog), add an entry to that catalog's `marketplace.json` whose `source` points at this repo. `examples/marketplace.json` is the template:

```json
{
  "name": "my-catalog",
  "owner": { "name": "you", "email": "you@example.com" },
  "plugins": [
    {
      "name": "seismo-cc",
      "source": "github:MulhamAryan/seismo-cc",
      "version": "0.1.0",
      "category": "maintenance"
    }
  ]
}
```

Then, inside Claude Code:

```
/plugin marketplace add your-org/your-catalog
/plugin install seismo-cc@your-catalog
```

---

## 4. Standalone CLI

The engine runs without Claude Code at all. From a clone:

```bash
node bin/impact.js analyze --symbols Checkout,OrderService --short
node bin/impact.js analyze --files src/Domain/Checkout.cs
node bin/impact.js analyze --diff --base origin/main
node bin/impact.js gate --file src/Domain/Checkout.cs
```

To get a global `seismo-cc` command:

```bash
cd seismo-cc
npm link          # exposes the "seismo-cc" bin on your PATH
seismo-cc analyze --symbols Checkout --short
```

Outputs land in `.impact/`: `report.md` (readable) and `latest.json` (machine). Add `.impact/` to the target repo's `.gitignore`.

Options: `--root <dir>` `--workspace <dir>` `--base <ref>` `--json` `--short`.

---

## 5. MCP server (`seismo-impact`)

The same engine, exposed as a zero-dependency stdio JSON-RPC server. When installed as a Claude Code plugin (method 1 or 2) it is declared automatically via `.claude-plugin/plugin.json` and needs no setup.

To register it manually in another MCP client, point the client at:

```json
{
  "mcpServers": {
    "seismo-impact": {
      "command": "node",
      "args": ["/absolute/path/to/seismo-cc/src/mcp-servers/seismo-impact/index.js"]
    }
  }
}
```

Tools: `get_blast_radius`, `get_affected_tests`, `get_public_api_diff`, `get_irreversible_ops`. See the README for their inputs and outputs.

---

## 6. Per-repo configuration

Optional but recommended before trusting the risk levels. In the repo you analyze:

```bash
echo ".impact/" >> .gitignore
cp /path/to/seismo-cc/impact.config.example.json impact.config.json
```

Every field is optional and self-documented in the example (thresholds, `workspace`, `ignore`, `testPatterns`, `gitDepth`, `externalConsumers`, `memoryPath`). Calibrate `thresholds` **after** measuring on the repo — a monolith and a microservice do not share the same numbers.

---

## Verify the install

```bash
node test/verify-install.js     # checks the plugin components are well-formed
./test/smoke.sh                 # 81 assertions on the engine and the guard (needs bash + git)
```

Inside Claude Code, confirm the plugin loaded:

```
/plugin            # seismo-cc should appear as installed / enabled
/seismo-cc:impact  # the command should be available
```

---

## Uninstall

- **Marketplace install:** `/plugin uninstall seismo-cc@seismo-cc` then, optionally, `/plugin marketplace remove seismo-cc`.
- **Local `--plugin-dir`:** stop passing `--plugin-dir`, or delete the clone.
- **CLI `npm link`:** `npm unlink -g seismo-cc`.
- Per repo: remove `impact.config.json` and the `.impact/` directory.
