#!/usr/bin/env bash
# Tests du moteur et du garde-fou. Ce qui est vérifiable sans lancer Claude Code.
#
#   ./test/smoke.sh
#
# Sort en 1 au premier échec, avec le détail.
set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMPACT="node $PLUGIN_ROOT/bin/impact.js"
WS="/tmp/seismo-cc-fixture"
API="$WS/pharma-api"

PASS=0; FAIL=0

ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; PASS=$((PASS+1)); }
ko()   { printf '  \033[31mKO\033[0m   %s\n     attendu : %s\n     obtenu  : %s\n' "$1" "$2" "$3"; FAIL=$((FAIL+1)); }
have() { # have <libellé> <motif> <texte>
  if grep -qi -- "$2" <<<"$3"; then ok "$1"; else ko "$1" "contient « $2 »" "$(head -c 300 <<<"$3")"; fi
}
lacks() {
  if grep -qi -- "$2" <<<"$3"; then ko "$1" "ne contient pas « $2 »" "$(head -c 300 <<<"$3")"; else ok "$1"; fi
}
rc_is() { # rc_is <libellé> <attendu> <obtenu>
  if [ "$3" = "$2" ]; then ok "$1"; else ko "$1" "rc=$2" "rc=$3"; fi
}

echo "→ préparation de la fixture"
bash "$PLUGIN_ROOT/test/fixture.sh" "$WS" >/dev/null
cd "$API"

echo
echo "→ 1. moteur, mode plan"
OUT=$($IMPACT analyze --symbols DispenseOrder --short 2>&1)
have "symbole résolu"                 "DispenseOrder"                      "$OUT"
have "appelants trouvés"              "Callers: [1-9]"                     "$OUT"
have "couplage historique remonté"    "CreateDispenseOrderEndpoint"        "$OUT"
have "repository couplé (SQL brut)"   "DispenseRepository"                 "$OUT"
have "SQL brut détecté"               "Raw SQL"                            "$OUT"
have "surface publique détectée"      "public-surface"                     "$OUT"
have "test identifié"                 "Priority tests: [1-9]"              "$OUT"

echo
echo "→ 2. rapport écrit sur disque"
[ -f .impact/report.md ]   && ok "report.md créé"   || ko "report.md créé" "fichier présent" "absent"
[ -f .impact/latest.json ] && ok "latest.json créé" || ko "latest.json créé" "fichier présent" "absent"
JSONOK=$(node -e "const d=require('$API/.impact/latest.json'); console.log(d.risk.level && d.symbols.length ? 'ok':'ko')" 2>&1)
have "latest.json exploitable" "ok" "$JSONOK"
REP=$(cat .impact/report.md)
have "étiquette de confiance textuelle"  "confidence: textual"     "$REP"
have "étiquette de confiance historique" "confidence: historical"  "$REP"
have "section angles morts"              "Blind spots"             "$REP"
lacks "pas d'auto-pollution du rapport"  "\.impact/report\.md"     "$REP"

echo
echo "→ 3. migration destructive → BLOQUANT"
git add -A >/dev/null 2>&1
OUT=$($IMPACT analyze --diff --base HEAD --short 2>&1)
have "passage en BLOQUANT"            "BLOCKING"                           "$OUT"
have "migration destructive nommée"   "Destructive migration"             "$OUT"

echo
echo "→ 4. cross-repo"
OUT=$($IMPACT analyze --symbols DispenseOrder --workspace "$WS" --short 2>&1)
have "consommateur mobile détecté"    "mobile-client"                      "$OUT"

echo
echo "→ 5. garde-fou"
$IMPACT analyze --symbols DispenseOrder >/dev/null 2>&1   # rapport frais, non bloquant
$IMPACT gate --file src/Domain/DispenseOrder.cs >/dev/null 2>&1
rc_is "fichier couvert → passe"       "0" "$?"
$IMPACT gate --file app/Http/Controllers/PharmacyController.php >/dev/null 2>&1
rc_is "fichier hors périmètre → bloque" "1" "$?"
rm -rf .impact
$IMPACT gate --file src/Domain/DispenseOrder.cs >/dev/null 2>&1
rc_is "aucun rapport → bloque"        "1" "$?"

echo
echo "→ 6. hook PreToolUse (contrat Claude Code)"
$IMPACT analyze --symbols DispenseOrder >/dev/null 2>&1
mkjson() { printf '{"cwd":"%s","hook_event_name":"PreToolUse","tool_name":"%s","tool_input":{"file_path":"%s"}}' "$API" "$2" "$1"; }

mkjson "$API/src/Domain/DispenseOrder.cs" Edit | node "$PLUGIN_ROOT/hooks/impact-gate.js" >/dev/null 2>&1
rc_is "couvert → exit 0"              "0" "$?"
ERR=$(mkjson "$API/app/Http/Controllers/PharmacyController.php" Edit | node "$PLUGIN_ROOT/hooks/impact-gate.js" 2>&1 >/dev/null)
rc_is "non couvert → exit 2"          "2" "$?"
have "message anti-arrêt présent"     "not a user refusal"                 "$ERR"
have "chemin du plugin résolu"        "$PLUGIN_ROOT/bin/impact.js"         "$ERR"
mkjson "$API/README.md" Write | node "$PLUGIN_ROOT/hooks/impact-gate.js" >/dev/null 2>&1
rc_is "extension non gardée → exit 0" "0" "$?"
mkjson "$API/src/Domain/Nouveau.cs" Write | node "$PLUGIN_ROOT/hooks/impact-gate.js" >/dev/null 2>&1
rc_is "fichier neuf → exit 0"         "0" "$?"

echo
echo "→ 7. dégradation gracieuse"
mkdir -p /tmp/ci-nogit && cd /tmp/ci-nogit && echo "class Foo {}" > f.cs
OUT=$($IMPACT analyze --files f.cs --short 2>&1)
lacks "hors repo git : pas d'erreur git en sortie" "fatal:" "$OUT"
have  "hors repo git : analyse quand même"         "Impact"  "$OUT"
cd "$API"
OUT=$($IMPACT analyze --symbols ZzzInexistant --short 2>&1)
have "symbole inconnu : sortie propre" "Impact LOW" "$OUT"

echo
echo "→ 8. structure du plugin"
for f in .claude-plugin/plugin.json hooks/hooks.json examples/marketplace.json impact.config.example.json; do
  node -e "JSON.parse(require('fs').readFileSync('$PLUGIN_ROOT/$f','utf8'))" >/dev/null 2>&1 \
    && ok "JSON valide : $f" || ko "JSON valide : $f" "parsable" "erreur de parsing"
done
for f in agents/impact-analyst.md skills/impact-analysis/SKILL.md commands/impact.md; do
  head -1 "$PLUGIN_ROOT/$f" | grep -q -- "---" \
    && ok "frontmatter présent : $f" || ko "frontmatter présent : $f" "---" "$(head -1 "$PLUGIN_ROOT/$f")"
done
grep -q "CLAUDE_PLUGIN_ROOT" "$PLUGIN_ROOT/hooks/hooks.json" \
  && ok "hooks.json utilise CLAUDE_PLUGIN_ROOT" || ko "hooks.json utilise CLAUDE_PLUGIN_ROOT" "variable" "chemin en dur"
for f in bin/impact.js hooks/impact-gate.js lib/config.js lib/git.js lib/report.js lib/rules.js lib/scan.js; do
  node --check "$PLUGIN_ROOT/$f" >/dev/null 2>&1 \
    && ok "syntaxe : $f" || ko "syntaxe : $f" "valide" "erreur"
done

echo
echo "→ 9. exclusion par segment, pas sous-chaîne (Phase 1)"
IGN=$(node -e '
  const { ignored } = require(process.argv[1]);
  const ig = ["node_modules",".git",".impact","bin","obj","dist","build","out","vendor","packages","wwwroot/lib","*.min.js","*.designer.cs"];
  const t = (rel, exp) => {
    const name = rel.split("/").pop();
    const got = ignored(rel, name, ig);
    console.log((got === exp ? "PASS" : "FAIL") + " " + rel + " => " + got + " (attendu " + exp + ")");
  };
  // Ne doivent PAS être exclus (sous-chaîne piégeuse) :
  t("routes/web.php", false);
  t("src/Distance.cs", false);
  t("app/query_builder.php", false);
  t("src/Logout.cs", false);
  t("src/Cabinet.cs", false);
  // Doivent être exclus (segment réel) :
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
    FAIL*) ko "${line#FAIL }" "match correct" "$line" ;;
    *)     ko "exécution du test d'exclusion" "sortie node" "$line" ;;
  esac
done <<<"$IGN"

echo
echo "→ 10. fraîcheur par empreinte de contenu (Phase 2+3)"
cd "$API"
$IMPACT analyze --symbols DispenseOrder >/dev/null 2>&1
HASHOK=$(node -e "const d=require('$API/.impact/latest.json'); const h=d.fileHashes||{}; console.log(h['src/Domain/DispenseOrder.cs'] ? 'ok':'ko')" 2>&1)
have "empreintes enregistrées dans latest.json" "ok" "$HASHOK"
$IMPACT gate --file src/Domain/DispenseOrder.cs >/dev/null 2>&1
rc_is "contenu inchangé → passe"        "0" "$?"
printf '\n// touche %s\n' "$(date +%s 2>/dev/null || echo x)" >> src/Domain/DispenseOrder.cs
$IMPACT gate --file src/Domain/DispenseOrder.cs >/dev/null 2>&1
rc_is "contenu modifié depuis l'analyse → bloque" "1" "$?"
ERR=$($IMPACT gate --file src/Domain/DispenseOrder.cs 2>&1 >/dev/null)
have "message empreinte différente"     "has changed since the analysis"     "$ERR"

echo
echo "→ 11. --json propre : stdout parsable, statut sur stderr (Phase 4)"
cd "$API"
JOUT=$($IMPACT analyze --symbols DispenseOrder --json 2>/dev/null)
PARSE=$(printf '%s' "$JOUT" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{JSON.parse(d);console.log('ok')}catch(e){console.log('ko:'+e.message)}})" 2>&1)
have "stdout est du JSON pur"           "^ok$"                               "$PARSE"
JERR=$($IMPACT analyze --symbols DispenseOrder --json 2>&1 >/dev/null)
have "ligne de statut sur stderr"       "report written to .impact"          "$JERR"
lacks "pas de statut dans stdout JSON"  "report written to .impact"          "$JOUT"

echo
echo "→ 12. cap non silencieux + occurrences (Phase 5)"
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
  t("compte NON plafonné (>50)", c.count>50);
  t("liste d affichage bornée à 50", (c.lines||[]).length===50);
  t("troncature signalée", c.truncated===true);
  t("occurrences > lignes distinctes", c.occurrences>c.count);
  const data={mode:"plan",risk:{level:"faible",reasons:["x"]},repo:"r",branch:"b",head:"h",generatedAt:"now",configFound:true,symbols:[],topCallers:[Object.assign({symbol:"Widget"},c)],coupling:[],apiSurface:[],irreversible:[],tests:[],crossRepo:[],externalConsumers:[],changedFiles:[]};
  t("rapport mentionne la troncature", /truncated/.test(report.render(data)));
' "$PLUGIN_ROOT/lib/scan.js" "$PLUGIN_ROOT/lib/report.js" 2>&1)
while IFS= read -r line; do
  case "$line" in
    PASS*) ok "${line#PASS }" ;;
    FAIL*) ko "${line#FAIL }" "condition vraie" "$line" ;;
    *)     ko "test troncature (exécution)" "sortie PASS/FAIL" "$line" ;;
  esac
done <<<"$TR12"
cd "$API"

echo
echo "→ 13. unités phases 6-9 (dédup merge, decl .cs, namespace, stripNoise)"
U13=$(node "$PLUGIN_ROOT/test/unit.js" 2>&1)
while IFS= read -r line; do
  case "$line" in
    PASS*) ok "${line#PASS }" ;;
    FAIL*) ko "${line#FAIL }" "condition vraie" "$line" ;;
    *)     ko "test unitaire (exécution)" "sortie PASS/FAIL" "$line" ;;
  esac
done <<<"$U13"

echo
echo "────────────────────────────────"
printf '%s réussis, %s échoués\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
