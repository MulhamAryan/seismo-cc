'use strict';
// Tests unitaires portables des phases 6-9 (résolution, dédup, stripNoise).
// require relatif au fichier : indépendant du cwd et de l'OS.
const scan = require('../lib/scan');
const git = require('../lib/git');

const t = (label, cond) => console.log((cond ? 'PASS' : 'FAIL') + ' ' + label);

// --- Phase 6 : parseLog dédoublonne les SHA (merges -m) ---
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const commits = git.parseLog(`${A}\nfile1.cs\n${A}\nfile2.cs\n${B}\nfile1.cs\n`);
t('Phase6: parseLog dédoublonne les SHA', commits.length === 2);
const ca = commits.find(c => c.sha === A);
t('Phase6: fichiers fusionnés sous un même SHA',
  !!ca && ca.files.length === 2 && ca.files.includes('file1.cs') && ca.files.includes('file2.cs'));

// --- Phase 9 : déclarations .cs (private, expression-bodied, attribut) ---
const cs = [
  'namespace N {',                       // 1
  ' public class C {',                   // 2
  '  private int Hidden() { return 1; }',// 3
  '  public int Total => _a + _b;',      // 4
  '  [HttpGet] public string Fetch() => "x";', // 5
  '  public class Widget { }',           // 6
  ' }',                                  // 7
  '}',                                   // 8
].join('\n');
const decls = scan.declarations('C.cs', cs);
const has = (n, k) => decls.some(d => d.name === n && d.kind === k);
t('Phase9: méthode private détectée', has('Hidden', 'method'));
t('Phase9: propriété expression-bodied détectée', has('Total', 'property'));
t('Phase9: méthode avec attribut détectée', has('Fetch', 'method'));
t('Phase9: type imbriqué détecté', has('Widget', 'type'));

// --- Phase 7 : namespaceAt ---
t('Phase7: namespaceAt trouve le namespace', scan.namespaceAt(cs, 6) === 'N');
const csFileScoped = 'namespace Foo.Bar;\npublic class Z { }\n';
t('Phase7: namespaceAt gère file-scoped', scan.namespaceAt(csFileScoped, 2) === 'Foo.Bar');

// --- Phase 8 : stripNoise (verbatim / interpolé / template) ---
const interp = 'var s = $"total {OrderService.Sum()} FooLiteral";';
const si = scan.stripNoise(interp, 'x.cs');
t('Phase8: interpolation conserve l\'expression', /OrderService/.test(si));
t('Phase8: interpolation supprime le littéral', !/FooLiteral/.test(si));
const verbatim = 'var p = @"WidgetLiteralPath";';
t('Phase8: verbatim supprime le contenu', !/WidgetLiteral/.test(scan.stripNoise(verbatim, 'x.cs')));
const tpl = 'const s = `total ${orderService.sum()} FooLiteral`;';
const st = scan.stripNoise(tpl, 'x.ts');
t('Phase8: template TS conserve ${expr}', /orderService/.test(st));
t('Phase8: template TS supprime le littéral', !/FooLiteral/.test(st));

// --- Import graph : importedNames (noms courts importés) ---
const phpImports = 'use App\\A\\Order;\nuse App\\B\\Thing as Alias;';
const namesPhp = scan.importedNames(phpImports, 'x.php');
t('Import: PHP use importe le nom court', namesPhp.has('Order'));
t('Import: PHP use ... as capture l\'alias', namesPhp.has('Alias'));
const tsImports = "import Foo, { Bar, Baz as Qux } from 'x'";
const namesTs = scan.importedNames(tsImports, 'x.ts');
t('Import: TS import par défaut', namesTs.has('Foo'));
t('Import: TS import nommé', namesTs.has('Bar'));
t('Import: TS import nommé avec alias', namesTs.has('Qux'));

// --- qualifierBefore : nature du site (member / static / new / null) ---
const qMember = '$x->save()';
t('Qualifier: appel membre ->', scan.qualifierBefore(qMember, qMember.indexOf('save')) === 'member');
const qStatic = 'Foo::bar';
t('Qualifier: appel statique ::', scan.qualifierBefore(qStatic, qStatic.indexOf('bar')) === 'static');
const qNew = 'new Order(';
t('Qualifier: instanciation new', scan.qualifierBefore(qNew, qNew.indexOf('Order')) === 'new');
const qBare = ' save';
t('Qualifier: mot nu non qualifié renvoie null', scan.qualifierBefore(qBare, qBare.indexOf('save')) === null);

// --- references : confiance + exclusion des variables (fixture disque réel) ---
const fs = require('fs');
const path = require('path');
const REFDIR = 'C:/Users/M7344~1.ARY/AppData/Local/Temp/1/claude/D--projects-claude-impact/e8693818-1a9b-429e-b6bb-5e637cc11fa1/scratchpad/reftest';
fs.mkdirSync(REFDIR, { recursive: true });
fs.writeFileSync(path.join(REFDIR, 'Order.php'),
  '<?php\nnamespace App\\A;\nclass Order {\n  public function save() { }\n}\n');
fs.writeFileSync(path.join(REFDIR, 'Uses.php'),
  '<?php\nnamespace App\\B;\nuse App\\A\\Order;\nclass Uses {\n  public function run() {\n    $o = new Order();\n    $o->save();\n  }\n}\n');
fs.writeFileSync(path.join(REFDIR, 'VarOnly.php'),
  '<?php\nnamespace App\\C;\nclass VarOnly {\n  public function run() {\n    $save = 1;\n    return $save;\n  }\n}\n');
// Homonyme d'un AUTRE module : importPathFor renvoie un chemin différent =>
// importElsewhere => confiance rétrogradée à 'low' (teste importPathFor via references,
// la fonction n'étant pas exportée par le module).
fs.writeFileSync(path.join(REFDIR, 'Elsewhere.php'),
  '<?php\nnamespace App\\B;\nuse App\\OTHER\\Order;\nclass Elsewhere {\n  public function run() {\n    $o = new Order();\n  }\n}\n');

// Symbole 'Order' : le fichier qui l'importe (chemin exact) est high + imported.
const refsOrder = scan.references(REFDIR, ['Order.php', 'Uses.php'], 'Order', 'Order.php');
const hitUses = refsOrder.find(h => h.file === 'Uses.php');
t('References: fichier important le symbole => confidence high', !!hitUses && hitUses.confidence === 'high');
t('References: fichier important le symbole => imported:true', !!hitUses && hitUses.imported === true);

// Homonyme importé d'un autre module => importPathFor pointe ailleurs => low.
const refsElse = scan.references(REFDIR, ['Order.php', 'Elsewhere.php'], 'Order', 'Order.php');
const hitElse = refsElse.find(h => h.file === 'Elsewhere.php');
t('References: homonyme d\'un autre module => confidence low', !!hitElse && hitElse.confidence === 'low');

// Symbole 'save' : la variable PHP $save ne doit PAS être comptée ((?<![\w$])).
const refsSave = scan.references(REFDIR, ['VarOnly.php'], 'save', null);
t('References: variable $save exclue (aucun site compté)', !refsSave.some(h => h.file === 'VarOnly.php'));

// --- rules.apiSurfaceOfContent : détection d'un endpoint ASP.NET ---
const rules = require('../lib/rules');
const apiFindings = rules.apiSurfaceOfContent('[HttpGet("orders")] public string X(){}', 'C.cs');
const aspnet = apiFindings.find(f => f.id === 'aspnet-attr');
t('ApiSurface: finding aspnet-attr détecté', !!aspnet);
t('ApiSurface: échantillon contient HttpGet',
  !!aspnet && aspnet.samples.some(s => s.includes('HttpGet')));

// --- eonix-memory : recordMany idempotent + priorHints advisory ---
const memory = require('../lib/memory');
const os = require('os');
const memDir = path.join(os.tmpdir(), 'seismo-memtest-' + process.pid);
fs.mkdirSync(memDir, { recursive: true });
const memCfg = { memoryPath: path.join(memDir, 'memory.json') };
const inc = { file: 'src/Order.cs', kind: 'revert', ref: 'revert:abc', at: '2026-01-01' };
const added1 = memory.recordMany(memCfg, memDir, [inc]);
const added2 = memory.recordMany(memCfg, memDir, [inc]); // même clé => dédoublonné
t('Memory: recordMany écrit un incident', added1 === 1);
t('Memory: recordMany idempotent (rejeu = 0)', added2 === 0);
const loaded = memory.load(memCfg, memDir);
t('Memory: load relit l\'incident', loaded.incidents.length === 1);
// priorHints : incident fichier remonté comme hint file-kind.
const hints = memory.priorHints(loaded, [], ['src/Order.cs']);
t('Memory: priorHints remonte l\'incident fichier',
  hints.length === 1 && hints[0].kind === 'file' && hints[0].incidents === 1);
// priorHints : store vide => aucun hint.
t('Memory: priorHints vide si pas d\'incident', memory.priorHints({ incidents: [] }, [], ['x']).length === 0);
// load : memoryPath null => mémoire vide, jamais d'exception (dégradation).
t('Memory: memoryPath null => vide', memory.load({ memoryPath: null }, memDir).incidents.length === 0);
