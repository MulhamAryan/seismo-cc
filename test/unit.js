'use strict';
// Portable unit tests for phases 6-9 (resolution, dedup, stripNoise).
// require relative to the file: independent of the cwd and the OS.
const scan = require('../lib/scan');
const git = require('../lib/git');

const t = (label, cond) => console.log((cond ? 'PASS' : 'FAIL') + ' ' + label);

// --- Phase 6: parseLog deduplicates SHAs (merges -m) ---
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const commits = git.parseLog(`${A}\nfile1.cs\n${A}\nfile2.cs\n${B}\nfile1.cs\n`);
t('Phase6: parseLog deduplicates SHAs', commits.length === 2);
const ca = commits.find(c => c.sha === A);
t('Phase6: files merged under a single SHA',
  !!ca && ca.files.length === 2 && ca.files.includes('file1.cs') && ca.files.includes('file2.cs'));

// --- Phase 9: .cs declarations (private, expression-bodied, attribute) ---
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
t('Phase9: private method detected', has('Hidden', 'method'));
t('Phase9: expression-bodied property detected', has('Total', 'property'));
t('Phase9: method with attribute detected', has('Fetch', 'method'));
t('Phase9: nested type detected', has('Widget', 'type'));

// --- Phase 7: namespaceAt ---
t('Phase7: namespaceAt finds the namespace', scan.namespaceAt(cs, 6) === 'N');
const csFileScoped = 'namespace Foo.Bar;\npublic class Z { }\n';
t('Phase7: namespaceAt handles file-scoped', scan.namespaceAt(csFileScoped, 2) === 'Foo.Bar');

// --- Phase 8: stripNoise (verbatim / interpolated / template) ---
const interp = 'var s = $"total {OrderService.Sum()} FooLiteral";';
const si = scan.stripNoise(interp, 'x.cs');
t('Phase8: interpolation keeps the expression', /OrderService/.test(si));
t('Phase8: interpolation strips the literal', !/FooLiteral/.test(si));
const verbatim = 'var p = @"WidgetLiteralPath";';
t('Phase8: verbatim strips the content', !/WidgetLiteral/.test(scan.stripNoise(verbatim, 'x.cs')));
const tpl = 'const s = `total ${orderService.sum()} FooLiteral`;';
const st = scan.stripNoise(tpl, 'x.ts');
t('Phase8: TS template keeps ${expr}', /orderService/.test(st));
t('Phase8: TS template strips the literal', !/FooLiteral/.test(st));

// --- Import graph: importedNames (short imported names) ---
const phpImports = 'use App\\A\\Order;\nuse App\\B\\Thing as Alias;';
const namesPhp = scan.importedNames(phpImports, 'x.php');
t('Import: PHP use imports the short name', namesPhp.has('Order'));
t('Import: PHP use ... as captures the alias', namesPhp.has('Alias'));
const tsImports = "import Foo, { Bar, Baz as Qux } from 'x'";
const namesTs = scan.importedNames(tsImports, 'x.ts');
t('Import: TS default import', namesTs.has('Foo'));
t('Import: TS named import', namesTs.has('Bar'));
t('Import: TS named import with alias', namesTs.has('Qux'));

// --- qualifierBefore: nature of the site (member / static / new / null) ---
const qMember = '$x->save()';
t('Qualifier: member call ->', scan.qualifierBefore(qMember, qMember.indexOf('save')) === 'member');
const qStatic = 'Foo::bar';
t('Qualifier: static call ::', scan.qualifierBefore(qStatic, qStatic.indexOf('bar')) === 'static');
const qNew = 'new Order(';
t('Qualifier: new instantiation', scan.qualifierBefore(qNew, qNew.indexOf('Order')) === 'new');
const qBare = ' save';
t('Qualifier: bare unqualified word returns null', scan.qualifierBefore(qBare, qBare.indexOf('save')) === null);

// --- references: confidence + exclusion of variables (real on-disk fixture) ---
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
// Homonym from ANOTHER module: importPathFor returns a different path =>
// importElsewhere => confidence downgraded to 'low' (tests importPathFor via references,
// since the function is not exported by the module).
fs.writeFileSync(path.join(REFDIR, 'Elsewhere.php'),
  '<?php\nnamespace App\\B;\nuse App\\OTHER\\Order;\nclass Elsewhere {\n  public function run() {\n    $o = new Order();\n  }\n}\n');

// Symbol 'Order': the file that imports it (exact path) is high + imported.
const refsOrder = scan.references(REFDIR, ['Order.php', 'Uses.php'], 'Order', 'Order.php');
const hitUses = refsOrder.find(h => h.file === 'Uses.php');
t('References: file importing the symbol => confidence high', !!hitUses && hitUses.confidence === 'high');
t('References: file importing the symbol => imported:true', !!hitUses && hitUses.imported === true);

// Homonym imported from another module => importPathFor points elsewhere => low.
const refsElse = scan.references(REFDIR, ['Order.php', 'Elsewhere.php'], 'Order', 'Order.php');
const hitElse = refsElse.find(h => h.file === 'Elsewhere.php');
t('References: homonym from another module => confidence low', !!hitElse && hitElse.confidence === 'low');

// Symbol 'save': the PHP variable $save must NOT be counted ((?<![\w$])).
const refsSave = scan.references(REFDIR, ['VarOnly.php'], 'save', null);
t('References: variable $save excluded (no site counted)', !refsSave.some(h => h.file === 'VarOnly.php'));

// --- rules.apiSurfaceOfContent: detection of an ASP.NET endpoint ---
const rules = require('../lib/rules');
const apiFindings = rules.apiSurfaceOfContent('[HttpGet("orders")] public string X(){}', 'C.cs');
const aspnet = apiFindings.find(f => f.id === 'aspnet-attr');
t('ApiSurface: aspnet-attr finding detected', !!aspnet);
t('ApiSurface: sample contains HttpGet',
  !!aspnet && aspnet.samples.some(s => s.includes('HttpGet')));

// --- seismo-memory: recordMany idempotent + priorHints advisory ---
const memory = require('../lib/memory');
const os = require('os');
const memDir = path.join(os.tmpdir(), 'seismo-memtest-' + process.pid);
fs.mkdirSync(memDir, { recursive: true });
const memCfg = { memoryPath: path.join(memDir, 'memory.json') };
const inc = { file: 'src/Order.cs', kind: 'revert', ref: 'revert:abc', at: '2026-01-01' };
const added1 = memory.recordMany(memCfg, memDir, [inc]);
const added2 = memory.recordMany(memCfg, memDir, [inc]); // same key => deduplicated
t('Memory: recordMany writes an incident', added1 === 1);
t('Memory: recordMany idempotent (replay = 0)', added2 === 0);
const loaded = memory.load(memCfg, memDir);
t('Memory: load re-reads the incident', loaded.incidents.length === 1);
// priorHints: file incident surfaced as a file-kind hint.
const hints = memory.priorHints(loaded, [], ['src/Order.cs']);
t('Memory: priorHints surfaces the file incident',
  hints.length === 1 && hints[0].kind === 'file' && hints[0].incidents === 1);
// priorHints: empty store => no hint.
t('Memory: priorHints empty when no incident', memory.priorHints({ incidents: [] }, [], ['x']).length === 0);
// load: memoryPath null => empty memory, never an exception (graceful degradation).
t('Memory: memoryPath null => empty', memory.load({ memoryPath: null }, memDir).incidents.length === 0);
