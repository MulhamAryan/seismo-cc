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

// --- P1: hidden-dependency checks (advisory) ---
const hidden = require('../lib/hidden');
const hdir = fs.mkdtempSync(path.join(os.tmpdir(), 'seismo-hidden-'));
fs.writeFileSync(path.join(hdir, 'a.cs'), [
  'namespace N {',
  ' public class OrderService {',
  '  void M(string id) {',
  '   var t = Type.GetType("N.OrderService");',                       // reflection + name-in-string
  '   Db.Database.ExecuteSqlRaw("SELECT * FROM OrderServices WHERE Id = 1");', // sql-table (OrderService+s)
  '   var url = "/api/" + id;',                                       // route built by concatenation
  '  }',
  ' }',
  '}',
].join('\n'));
const hSyms = [{ name: 'OrderService', kind: 'type', declFile: 'a.cs' }];
const hRes = hidden.check(hdir, ['a.cs'], hSyms, ['a.cs']);
const hHas = k => hRes.some(h => h.kind === k);
t('P1: reflection-string detected', hRes.some(h => h.kind === 'reflection-string' && h.symbol === 'OrderService'));
t('P1: sql-table detected', hRes.some(h => h.kind === 'sql-table' && h.symbol === 'OrderService'));
t('P1: dynamic-construct (reflection) detected', hHas('dynamic-construct'));
t('P1: route-concat detected', hHas('route-concat'));
// Prose strings must NOT be flagged as a reflection reference (noise control).
fs.writeFileSync(path.join(hdir, 'b.cs'), 'class X { void M(){ Log("OrderService failed to start now"); } }\n');
t('P1: prose string not flagged', hidden.stringMentions(hdir, ['b.cs'], ['OrderService']).length === 0);

// --- P2: validation harness (coupling predictor precision/recall) ---
const validate = require('../lib/validate');

// couplingFrom is pure over a commit list. A co-changes with B in 3/4 of A's
// commits, with C in 1/4 (below 0.5, excluded).
const ccList = [
  { files: ['A', 'B'] }, { files: ['A', 'B'] }, { files: ['A', 'B'] }, { files: ['A', 'C'] },
];
const cf = git.couplingFrom(ccList, ['A'], { minCommits: 2, minRatio: 0.5 });
t('P2: couplingFrom keeps B at 0.75, drops C',
  cf.length === 1 && cf[0].file === 'B' && Math.abs(cf[0].ratio - 0.75) < 1e-9);

// evaluateAt: a history where A and B always ship together should score
// precision = recall = 1 (seed A predicts B, seed B predicts A).
const hist = [];
hist.push({ files: ['A', 'B'] });                 // newest = evaluation commit
for (let i = 0; i < 5; i++) hist.push({ files: ['A', 'B'] });  // prior history
const ev = validate.evaluateAt(hist, 2, 0.5, { minPriorCommits: 3, maxCommitFiles: 10 });
t('P2: perfect coupling -> precision 1', ev.precision === 1);
t('P2: perfect coupling -> recall 1', ev.recall === 1);
// Every commit with enough prior history is evaluated (index 0,1,2 here: prior
// 5,4,3 >= minPriorCommits 3), each contributing 2 seed queries.
t('P2: all eligible commits evaluated, 2 seeds each', ev.evalCommits === 3 && ev.queries === 6);

// A file never seen before drags recall down (unpredictable), never precision.
const hist2 = [];
hist2.push({ files: ['A', 'B', 'Z'] });           // Z is new, has no prior history
for (let i = 0; i < 5; i++) hist2.push({ files: ['A', 'B'] });
const ev2 = validate.evaluateAt(hist2, 2, 0.5, { minPriorCommits: 3, maxCommitFiles: 10 });
t('P2: unseen file lowers recall, not precision', ev2.precision === 1 && ev2.recall < 1);

// evaluateCoupling returns a grid and a best cell.
const sweep = validate.evaluateCoupling(hist, { minPriorCommits: 3, maxCommitFiles: 10, minCommitsList: [2], minRatioList: [0.5] });
t('P2: evaluateCoupling exposes a best cell', !!sweep.best && sweep.best.f1 === 1);

// --- P3: indirect (2-hop) impact ---
const transitive = require('../lib/transitive');
const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'seismo-transitive-'));
// svc.cs declares the changed type; ctrl.cs is a DIRECT caller and itself
// declares OrderController; view.cs references OrderController (2nd hop).
fs.writeFileSync(path.join(tdir, 'svc.cs'), 'namespace N;\npublic class OrderService {\n public void Run(){}\n}\n');
fs.writeFileSync(path.join(tdir, 'ctrl.cs'), 'namespace N;\npublic class OrderController {\n void M(){ new OrderService().Run(); }\n}\n');
fs.writeFileSync(path.join(tdir, 'view.cs'), 'namespace N;\npublic class HomeView {\n void M(){ var c = new OrderController(); }\n}\n');
const tFiles = ['svc.cs', 'ctrl.cs', 'view.cs'];
const ind = transitive.indirectImpact(tdir, tFiles, {
  directFiles: new Set(['ctrl.cs']),                         // hop-1: caller of OrderService
  exclude: new Set(['svc.cs', 'ctrl.cs']),                   // targets + direct callers
  excludeNames: ['OrderService'],
});
t('P3: indirect impact finds the 2nd-hop file', ind.some(x => x.file === 'view.cs' && x.via.includes('OrderController')));
t('P3: indirect confidence labelled', ind.every(x => x.confidence === 'indirect'));
t('P3: direct callers excluded from indirect', !ind.some(x => x.file === 'ctrl.cs' || x.file === 'svc.cs'));
// The original symbol is not re-expanded as a seed.
const ind2 = transitive.indirectImpact(tdir, tFiles, {
  directFiles: new Set(['ctrl.cs']),
  exclude: new Set(['svc.cs', 'ctrl.cs', 'view.cs']),        // exclude everything downstream
  excludeNames: ['OrderService'],
});
t('P3: nothing indirect when downstream excluded', ind2.length === 0);
