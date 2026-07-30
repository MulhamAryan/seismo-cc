#!/usr/bin/env bash
# Crée un repo de test synthétique avec les pièges qui comptent :
# migration destructive, SQL brut concaténé, endpoint public, envoi de mail,
# et un repo frère consommateur pour vérifier le signal cross-repo.
#
#   ./test/fixture.sh [dossier]        (défaut : /tmp/seismo-cc-fixture)
set -euo pipefail

WS="${1:-/tmp/seismo-cc-fixture}"
rm -rf "$WS"
mkdir -p "$WS"

# ---------------------------------------------------------------- repo principal
API="$WS/pharma-api"
mkdir -p "$API"/{src/Domain,src/Api/Endpoints,src/Infrastructure/Migrations,tests/Domain.Tests,app/Http/Controllers,database/migrations}
cd "$API"
git init -q && git config user.email dev@example.com && git config user.name "Dev Example"
echo ".impact/" > .gitignore

cat > src/Domain/DispenseOrder.cs <<'EOF'
namespace Pharma.Domain;

public class DispenseOrder
{
    public Guid Id { get; set; }
    public string PatientCode { get; set; } = "";
    public DispenseStatus Status { get; set; }

    public void Cancel() { Status = DispenseStatus.Cancelled; }
}

public enum DispenseStatus { Draft, Submitted, Cancelled }
EOF

cat > src/Domain/DispenseOrderManager.cs <<'EOF'
namespace Pharma.Domain;

public class DispenseOrderManager
{
    public DispenseOrder Build(string patientCode) => new() { PatientCode = patientCode };
    public void CancelOrder(DispenseOrder order) => order.Cancel();
}
EOF

cat > src/Api/Endpoints/CreateDispenseOrderEndpoint.cs <<'EOF'
using FastEndpoints;
namespace Pharma.Api;

public class CreateDispenseOrderEndpoint : Endpoint<CreateDispenseOrderRequest>
{
    public override void Configure()
    {
        Post("/api/dispense-orders");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CreateDispenseOrderRequest req, CancellationToken ct)
    {
        var order = new DispenseOrderManager().Build(req.PatientCode);
        await SendOkAsync(order, ct);
    }
}

public class CreateDispenseOrderRequest { public string PatientCode { get; set; } = ""; }
EOF

# Piège : SQL brut concaténé. Aucun appel nommé à DispenseOrder dans la
# signature — seul le couplage historique le fera remonter.
cat > src/Infrastructure/DispenseRepository.cs <<'EOF'
namespace Pharma.Infrastructure;

public class DispenseRepository
{
    public void Purge(string code)
    {
        Db.Database.ExecuteSqlRaw("DELETE FROM DispenseOrders WHERE PatientCode = '" + code + "'");
    }
}
EOF

cat > tests/Domain.Tests/DispenseOrderTests.cs <<'EOF'
public class DispenseOrderTests
{
    [Fact]
    public void Cancel_sets_status()
    {
        var o = new DispenseOrder();
        o.Cancel();
    }
}
EOF

cat > app/Http/Controllers/PharmacyController.php <<'EOF'
<?php
namespace App\Http\Controllers;

class PharmacyController extends Controller
{
    public function sync()
    {
        Mail::to('alerts@example.com')->send(new SyncReport());
        return response()->json([]);
    }
}
EOF

git add -A && git commit -qm "init: domaine, endpoint, repository, tests"

# Historique : quatre commits touchant ensemble domaine + endpoint + repository.
# C'est ce qui crée le couplage à 100% que l'analyse statique ne verrait pas.
for i in 1 2 3 4; do
  printf '// évolution %s\n' "$i" >> src/Domain/DispenseOrder.cs
  printf '// évolution %s\n' "$i" >> src/Api/Endpoints/CreateDispenseOrderEndpoint.cs
  printf '// évolution %s\n' "$i" >> src/Infrastructure/DispenseRepository.cs
  git add -A && git commit -qm "feat: évolution $i"
done

# Migration destructive NON committée : sert à tester le mode --diff et le
# passage en BLOQUANT.
cat > src/Infrastructure/Migrations/20260715_DropLegacyRef.cs <<'EOF'
public partial class DropLegacyRef : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropColumn(name: "LegacyRef", table: "DispenseOrders");
    }
}
EOF

# ------------------------------------------------------------ repo consommateur
MOB="$WS/mobile-client"
mkdir -p "$MOB/src"
cd "$MOB"
git init -q && git config user.email dev@example.com && git config user.name "Dev Example"
cat > src/DispenseApi.kt <<'EOF'
package com.example.app

class DispenseApi {
    suspend fun fetch(): List<DispenseOrder> =
        client.get("/api/dispense-orders").body()
}
EOF
git add -A && git commit -qm "init: client mobile KMP"

echo "Fixture prête : $WS"
echo "  repo principal : $API"
echo "  consommateur   : $MOB"
