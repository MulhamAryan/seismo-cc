'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // Fichiers ignorés lors du scan. Volontairement large : mieux vaut manquer
  // un usage dans du code généré que noyer le rapport.
  ignore: [
    'node_modules', '.git', '.impact', 'bin', 'obj', 'dist', 'build', 'out',
    'vendor', 'packages', '.next', '.nuxt', 'coverage', 'wwwroot/lib',
    '*.min.js', '*.designer.cs', '*.g.cs', '*.generated.cs', '*.lock',
  ],
  // Extensions considérées comme du code source analysable.
  extensions: ['.cs', '.php', '.kt', '.kts', '.ts', '.tsx', '.js', '.jsx', '.vue', '.razor', '.cshtml', '.blade.php', '.sql'],
  // Fichiers de test : reconnus par chemin ou par nom.
  testPatterns: ['Tests/', 'Test/', 'tests/', '.Tests.', 'Test.cs', 'Tests.cs', 'Test.php', 'Spec.php', '.spec.', '.test.'],
  // Profondeur de l'historique git analysé pour le couplage de co-changement.
  gitDepth: 400,
  // Seuils de gate. Ajuste-les APRÈS avoir mesuré sur tes repos : un gate qui
  // hurle à chaque ticket est ignoré en deux semaines.
  thresholds: {
    callersWarn: 15,
    callersHigh: 40,
    couplingMinCommits: 3,   // ignore le bruit statistique
    couplingMinRatio: 0.4,   // co-changé dans >=40% des commits touchant la cible
    reportMaxAgeMinutes: 120,
  },
  // Consommateurs externes déclarés à la main. Le graphe ne les devinera pas.
  // Sert à faire remonter "cette modif casse quelqu'un hors du repo".
  externalConsumers: [],
  // Répertoire parent des repos frères, pour le scan cross-repo optionnel.
  workspace: null,
  // Store seismo-memory (JSON) : historique advisory des incidents passés.
  // null = désactivé (défaut) ; chemin relatif = ancré sur la racine du repo ;
  // chemin absolu ou central pour partager entre repos. Purement advisory :
  // n'influence jamais risk.level ni le gate (voir lib/memory.js).
  memoryPath: null,
};

// Signatures d'opérations irréversibles ou à effet de bord non annulable.
// C'est la partie qui compte le plus : le reste est du confort, ça c'est du risque.
const IRREVERSIBLE = [
  { id: 'ef-migration', label: 'EF Core migration', re: /Migrations[\/\\].*\.cs$|class\s+\w+\s*:\s*Migration\b|migrationBuilder\.(Drop|Alter|Rename)/i, weight: 3 },
  { id: 'ef-destructive', label: 'Destructive migration (Drop/Alter column or table)', re: /migrationBuilder\.Drop(Column|Table|Index|ForeignKey)|migrationBuilder\.AlterColumn/i, weight: 5 },
  { id: 'laravel-migration', label: 'Laravel migration', re: /database[\/\\]migrations[\/\\]|Schema::(drop|dropIfExists|table)/i, weight: 3 },
  { id: 'laravel-destructive', label: 'Destructive Laravel migration', re: /->dropColumn|Schema::dropIfExists|->dropForeign/i, weight: 5 },
  { id: 'raw-sql', label: 'Raw SQL executed', re: /FromSqlRaw|ExecuteSqlRaw|ExecuteSqlInterpolated|DB::statement|DB::unprepared|new\s+SqlCommand/i, weight: 3 },
  { id: 'delete-bulk', label: 'Bulk delete', re: /ExecuteDelete\(|RemoveRange\(|->truncate\(|TRUNCATE\s+TABLE|DELETE\s+FROM/i, weight: 4 },
  { id: 'mail', label: 'Email sent', re: /IEmailSender|MailMessage|SmtpClient|Mail::(to|send|queue)|SendGrid|Mailer->send/i, weight: 3 },
  { id: 'job', label: 'Background job enqueued (Hangfire / queue)', re: /BackgroundJob\.(Enqueue|Schedule)|RecurringJob\.AddOrUpdate|dispatch\(|->onQueue\(|Bus::dispatch/i, weight: 2 },
  { id: 'payment', label: 'Payment / billing', re: /Stripe|Mollie|PaymentIntent|Invoice(Service|Client)|Ogone|Worldline/i, weight: 5 },
  { id: 'external-call', label: 'Outbound call to a third party', re: /HttpClient|Http::(get|post|put|delete)|WebClient|RestClient/i, weight: 1 },
  { id: 'filesystem', label: 'Write or delete on disk / object storage', re: /File\.Delete|Directory\.Delete|Storage::delete|MinioClient|S3Client|PutObject/i, weight: 2 },
  { id: 'auth', label: 'Authentication / authorization changed', re: /\[Authorize|AllowAnonymous|AddAuthentication|JwtBearer|middleware\(\s*['"]auth|Gate::|Policy/i, weight: 4 },
];

// Public surface: what breaks someone OUTSIDE this repo.
const API_SURFACE = [
  { id: 'aspnet-attr', label: 'ASP.NET endpoint', re: /\[Http(Get|Post|Put|Delete|Patch)(\("[^"]*"\))?\]|\[Route\("([^"]*)"\)\]/g },
  { id: 'fastendpoints', label: 'FastEndpoints endpoint', re: /:\s*Endpoint(WithoutRequest)?<|Get\("([^"]*)"\)|Post\("([^"]*)"\)|Put\("([^"]*)"\)|Delete\("([^"]*)"\)/g },
  { id: 'minimal-api', label: 'Minimal API', re: /app\.Map(Get|Post|Put|Delete|Patch)\(/g },
  { id: 'laravel-route', label: 'Laravel route', re: /Route::(get|post|put|patch|delete|apiResource|resource)\(/g },
  { id: 'signalr', label: 'SignalR hub', re: /:\s*Hub\b|IHubContext</g },
  { id: 'contract', label: 'Public contract (DTO / Request / Response)', re: /class\s+\w*(Request|Response|Dto|Contract|Command|Query)\b|record\s+\w*(Request|Response|Dto)\b/g },
];

function load(root) {
  const p = path.join(root, 'impact.config.json');
  let user = {};
  if (fs.existsSync(p)) {
    try {
      user = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      // Une config cassée doit être bruyante, pas silencieuse.
      throw new Error(`impact.config.json unreadable: ${e.message}`);
    }
  }
  const cfg = { ...DEFAULTS, ...user };
  cfg.thresholds = { ...DEFAULTS.thresholds, ...(user.thresholds || {}) };
  cfg.ignore = user.ignore ? DEFAULTS.ignore.concat(user.ignore) : DEFAULTS.ignore;
  cfg.root = root;
  cfg.configFound = fs.existsSync(p);
  return cfg;
}

module.exports = { load, DEFAULTS, IRREVERSIBLE, API_SURFACE };
