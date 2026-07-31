#!/usr/bin/env bash
# Engine and guard tests. Everything verifiable without launching Claude Code.
#
#   ./test/smoke.sh
#
# Exits 1 on the first failure, with details.
set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMPACT="node $PLUGIN_ROOT/bin/impact.js"
WS="/tmp/seismo-cc-fixture"
API="$WS/sample-service"

# Path handed to node INSIDE a string (a `node -e` literal or a JSON payload)
# is not mangled by MSYS/git-bash the way a bare argv is, so a POSIX path like
# /d/... or /tmp/... reaches node unconverted and fails on Windows. cygpath -m
# yields the mixed form (D:/...) that node accepts and that is JSON-safe
# (forward slashes need no escaping). No-op on Linux/macOS where cygpath is absent.
towin() { cygpath -m "$1" 2>/dev/null || printf '%s' "$1"; }
PRW="$(towin "$PLUGIN_ROOT")"
APIW="$(towin "$API")"

PASS=0; FAIL=0

ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; PASS=$((PASS+1)); }
ko()   { printf '  \033[31mKO\033[0m   %s\n     expected : %s\n     got      : %s\n' "$1" "$2" "$3"; FAIL=$((FAIL+1)); }
have() { # have <label> <pattern> <text>
  if grep -qi -- "$2" <<<"$3"; then ok "$1"; else ko "$1" "contains \"$2\"" "$(head -c 300 <<<"$3")"; fi
}
lacks() {
  if grep -qi -- "$2" <<<"$3"; then ko "$1" "does not contain \"$2\"" "$(head -c 300 <<<"$3")"; else ok "$1"; fi
}
rc_is() { # rc_is <label> <expected> <got>
  if [ "$3" = "$2" ]; then ok "$1"; else ko "$1" "rc=$2" "rc=$3"; fi
}

echo "-> preparing the fixture"
bash "$PLUGIN_ROOT/test/fixture.sh" "$WS" >/dev/null
cd "$API"

echo
echo "-> 1. engine, plan mode"
OUT=$($IMPACT analyze --symbols Checkout --short 2>&1)
have "symbol resolved"                "Checkout"                           "$OUT"
have "callers found"                  "Callers: [1-9]"                     "$OUT"
have "historical coupling surfaced"   "CreateCheckoutEndpoint"             "$OUT"
have "repository coupled (raw SQL)"   "CheckoutRepository"                 "$OUT"
have "raw SQL detected"               "Raw SQL"                            "$OUT"
have "public surface detected"        "public-surface"                     "$OUT"
have "test identified"                "Priority tests: [1-9]"              "$OUT"

echo
echo "-> 2. report written to disk"
[ -f .impact/report.md ]   && ok "report.md created"   || ko "report.md created" "file present" "absent"
[ -f .impact/latest.json ] && ok "latest.json created" || ko "latest.json created" "file present" "absent"
JSONOK=$(node -e "const d=require('$APIW/.impact/latest.json'); console.log(d.risk.level && d.symbols.length ? 'ok':'ko')" 2>&1)
have "latest.json usable" "ok" "$JSONOK"
REP=$(cat .impact/report.md)
have "textual confidence label"       "confidence: textual"     "$REP"
have "historical confidence label"    "confidence: historical"  "$REP"
have "blind spots section"            "Blind spots"             "$REP"
lacks "report does not self-pollute"  "\.impact/report\.md"     "$REP"

echo
echo "-> 3. destructive migration -> BLOCKING"
git add -A >/dev/null 2>&1
OUT=$($IMPACT analyze --diff --base HEAD --short 2>&1)
have "escalates to BLOCKING"          "BLOCKING"                           "$OUT"
have "destructive migration named"    "Destructive migration"             "$OUT"

echo
echo "-> 4. cross-repo"
OUT=$($IMPACT analyze --symbols Checkout --workspace "$WS" --short 2>&1)
have "mobile consumer detected"       "mobile-client"                      "$OUT"

echo
echo "-> 5. guard"
$IMPACT analyze --symbols Checkout >/dev/null 2>&1   # fresh report, non-blocking
$IMPACT gate --file src/Domain/Checkout.cs >/dev/null 2>&1
rc_is "covered file -> passes"        "0" "$?"
$IMPACT gate --file app/Http/Controllers/PartnerController.php >/dev/null 2>&1
rc_is "out-of-scope file -> blocks"   "1" "$?"
rm -rf .impact
$IMPACT gate --file src/Domain/Checkout.cs >/dev/null 2>&1
rc_is "no report -> blocks"           "1" "$?"

echo
echo "-> 6. PreToolUse hook (Claude Code contract)"
$IMPACT analyze --symbols Checkout >/dev/null 2>&1
# cwd and file_path go inside a JSON payload, so they must be the node-friendly
# mixed form (see towin above); the hook reads them with fs.
mkjson() { printf '{"cwd":"%s","hook_event_name":"PreToolUse","tool_name":"%s","tool_input":{"file_path":"%s"}}' "$APIW" "$2" "$(towin "$1")"; }

mkjson "$API/src/Domain/Checkout.cs" Edit | node "$PLUGIN_ROOT/hooks/impact-gate.js" >/dev/null 2>&1
rc_is "covered -> exit 0"             "0" "$?"

# Default mode is advisory: an uncovered file is NOT blocked, only warned.
ERR=$(mkjson "$API/app/Http/Controllers/PartnerController.php" Edit | node "$PLUGIN_ROOT/hooks/impact-gate.js" 2>&1 >/dev/null)
rc_is "advisory (default): not covered -> exit 0" "0" "$?"
have "advisory message present"       "impact advisory"                    "$ERR"

# Blocking mode (opt-in via config): the same edit is refused with exit 2.
printf '{ "gate": "blocking" }\n' > "$API/impact.config.json"
ERR=$(mkjson "$API/app/Http/Controllers/PartnerController.php" Edit | node "$PLUGIN_ROOT/hooks/impact-gate.js" 2>&1 >/dev/null)
rc_is "blocking: not covered -> exit 2" "2" "$?"
have "anti-stop message present"      "not a user refusal"                 "$ERR"
# Separator-agnostic: the hook may print the path with / or \ depending on OS.
have "plugin path resolved"           "bin.impact\.js"                     "$ERR"
rm -f "$API/impact.config.json"

mkjson "$API/README.md" Write | node "$PLUGIN_ROOT/hooks/impact-gate.js" >/dev/null 2>&1
rc_is "unguarded extension -> exit 0" "0" "$?"
mkjson "$API/src/Domain/New.cs" Write | node "$PLUGIN_ROOT/hooks/impact-gate.js" >/dev/null 2>&1
rc_is "new file -> exit 0"            "0" "$?"

echo
echo "-> 7. graceful degradation"
mkdir -p /tmp/ci-nogit && cd /tmp/ci-nogit && echo "class Foo {}" > f.cs
OUT=$($IMPACT analyze --files f.cs --short 2>&1)
lacks "outside git repo: no git error in output" "fatal:" "$OUT"
have  "outside git repo: still analyzes"          "Impact"  "$OUT"
cd "$API"
OUT=$($IMPACT analyze --symbols ZzzNonExistent --short 2>&1)
have "unknown symbol: clean output" "Impact LOW" "$OUT"

echo
echo "-> 8. plugin structure"
for f in .claude-plugin/plugin.json hooks/hooks.json examples/marketplace.json impact.config.example.json; do
  node -e "JSON.parse(require('fs').readFileSync('$PRW/$f','utf8'))" >/dev/null 2>&1 \
    && ok "JSON valid: $f" || ko "JSON valid: $f" "parsable" "parse error"
done
for f in agents/impact-analyst.md skills/impact-analysis/SKILL.md commands/impact.md; do
  head -1 "$PLUGIN_ROOT/$f" | grep -q -- "---" \
    && ok "frontmatter present: $f" || ko "frontmatter present: $f" "---" "$(head -1 "$PLUGIN_ROOT/$f")"
done
grep -q "CLAUDE_PLUGIN_ROOT" "$PLUGIN_ROOT/hooks/hooks.json" \
  && ok "hooks.json uses CLAUDE_PLUGIN_ROOT" || ko "hooks.json uses CLAUDE_PLUGIN_ROOT" "variable" "hardcoded path"
for f in bin/impact.js hooks/impact-gate.js lib/config.js lib/git.js lib/report.js lib/rules.js lib/scan.js; do
  node --check "$PLUGIN_ROOT/$f" >/dev/null 2>&1 \
    && ok "syntax: $f" || ko "syntax: $f" "valid" "error"
done

echo
echo "-> 9. exclusion by segment, not substring (Phase 1)"
IGN=$(node -e '
  const { ignored } = require(process.argv[1]);
  const ig = ["node_modules",".git",".impact","bin","obj","dist","build","out","vendor","packages","wwwroot/lib","*.min.js","*.designer.cs"];
  const t = (rel, exp) => {
    const name = rel.split("/").pop();
    const got = ignored(rel, name, ig);
    console.log((got === exp ? "PASS" : "FAIL") + " " + rel + " => " + got + " (expected " + exp + ")");
  };
  // Must NOT be excluded (substring trap):
  t("routes/web.php", false);
  t("src/Distance.cs", false);
  t("app/query_builder.php", false);
  t("src/Logout.cs", false);
  t("src/Cabinet.cs", false);
  // Must be excluded (real segment):
  t("bin/Debug/App.cs", true);
  t("node_modules/x/index.ts", true);
  t("src/obj/Gen.cs", true);
  t(".impact/report.md", true);
  t("wwwroot/lib/jquery.js", true);
  t("src/app.min.js", true);
  t("Foo.designer.cs", true);
' "$PLUGIN_ROOT/lib/scan.js" 2>&1)
while IFS= read -r line; do
  case "$line" in
    PASS*) ok "${line#PASS }" ;;
    FAIL*) ko "${line#FAIL }" "correct match" "$line" ;;
    *)     ko "exclusion test execution" "node output" "$line" ;;
  esac
done <<<"$IGN"

echo
echo "-> 10. freshness by content fingerprint (Phase 2+3)"
cd "$API"
$IMPACT analyze --symbols Checkout >/dev/null 2>&1
HASHOK=$(node -e "const d=require('$APIW/.impact/latest.json'); const h=d.fileHashes||{}; console.log(h['src/Domain/Checkout.cs'] ? 'ok':'ko')" 2>&1)
have "fingerprints recorded in latest.json" "ok" "$HASHOK"
$IMPACT gate --file src/Domain/Checkout.cs >/dev/null 2>&1
rc_is "content unchanged -> passes"     "0" "$?"
printf '\n// touch %s\n' "$(date +%s 2>/dev/null || echo x)" >> src/Domain/Checkout.cs
$IMPACT gate --file src/Domain/Checkout.cs >/dev/null 2>&1
rc_is "content changed since analysis -> blocks" "1" "$?"
ERR=$($IMPACT gate --file src/Domain/Checkout.cs 2>&1 >/dev/null)
have "different-fingerprint message"    "has changed since the analysis"     "$ERR"

echo
echo "-> 11. clean --json: parsable stdout, status on stderr (Phase 4)"
cd "$API"
JOUT=$($IMPACT analyze --symbols Checkout --json 2>/dev/null)
PARSE=$(printf '%s' "$JOUT" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{JSON.parse(d);console.log('ok')}catch(e){console.log('ko:'+e.message)}})" 2>&1)
have "stdout is pure JSON"              "^ok$"                               "$PARSE"
JERR=$($IMPACT analyze --symbols Checkout --json 2>&1 >/dev/null)
have "status line on stderr"            "report written to .impact"          "$JERR"
lacks "no status in JSON stdout"        "report written to .impact"          "$JOUT"

echo
echo "-> 12. non-silent cap + occurrences (Phase 5)"
TR12=$(node -e '
  const scan = require(process.argv[1]);
  const report = require(process.argv[2]);
  const fs=require("fs"),os=require("os"),path=require("path");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"trunc-"));
  fs.writeFileSync(path.join(dir,"widget.cs"),"namespace N { public class Widget { } }\n");
  let u="namespace N { public class Consumer {\n";
  for(let i=1;i<=55;i++) u+="  void M"+i+"() { var w = new Widget(); }\n";
  u+="  void Dbl() { Widget a = null; Widget b = null; }\n} }\n";
  fs.writeFileSync(path.join(dir,"usage.cs"),u);
  const refs=scan.references(dir,["widget.cs","usage.cs"],"Widget","widget.cs");
  const c=refs.find(x=>x.file==="usage.cs")||{};
  const t=(l,cond)=>console.log((cond?"PASS":"FAIL")+" "+l);
  t("count NOT capped (>50)", c.count>50);
  t("display list bounded to 50", (c.lines||[]).length===50);
  t("truncation reported", c.truncated===true);
  t("occurrences > distinct lines", c.occurrences>c.count);
  const data={mode:"plan",risk:{level:"low",reasons:["x"]},repo:"r",branch:"b",head:"h",generatedAt:"now",configFound:true,symbols:[],topCallers:[Object.assign({symbol:"Widget"},c)],coupling:[],apiSurface:[],irreversible:[],tests:[],crossRepo:[],externalConsumers:[],changedFiles:[]};
  t("report mentions the truncation", /truncated/.test(report.render(data)));
' "$PLUGIN_ROOT/lib/scan.js" "$PLUGIN_ROOT/lib/report.js" 2>&1)
while IFS= read -r line; do
  case "$line" in
    PASS*) ok "${line#PASS }" ;;
    FAIL*) ko "${line#FAIL }" "condition true" "$line" ;;
    *)     ko "truncation test (execution)" "PASS/FAIL output" "$line" ;;
  esac
done <<<"$TR12"
cd "$API"

echo
echo "-> 13. unit phases 6-9 (merge dedup, .cs decl, namespace, stripNoise)"
U13=$(node "$PLUGIN_ROOT/test/unit.js" 2>&1)
while IFS= read -r line; do
  case "$line" in
    PASS*) ok "${line#PASS }" ;;
    FAIL*) ko "${line#FAIL }" "condition true" "$line" ;;
    *)     ko "unit test (execution)" "PASS/FAIL output" "$line" ;;
  esac
done <<<"$U13"

echo
echo "--------------------------------"
printf '%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
