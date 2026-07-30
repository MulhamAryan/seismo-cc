#!/usr/bin/env bash
# Builds a synthetic test repo with the traps that matter:
# destructive migration, concatenated raw SQL, public endpoint, mail send,
# and a sibling consumer repo to exercise the cross-repo signal.
#
#   ./test/fixture.sh [dir]        (default: /tmp/seismo-cc-fixture)
set -euo pipefail

WS="${1:-/tmp/seismo-cc-fixture}"
rm -rf "$WS"
mkdir -p "$WS"

# ---------------------------------------------------------------- main repo
API="$WS/sample-service"
mkdir -p "$API"/{src/Domain,src/Api/Endpoints,src/Infrastructure/Migrations,tests/Domain.Tests,app/Http/Controllers,database/migrations}
cd "$API"
git init -q && git config user.email dev@example.com && git config user.name "Dev Example"
echo ".impact/" > .gitignore

cat > src/Domain/Checkout.cs <<'EOF'
namespace Sample.Domain;

public class Checkout
{
    public Guid Id { get; set; }
    public string CustomerCode { get; set; } = "";
    public CheckoutStatus Status { get; set; }

    public void Cancel() { Status = CheckoutStatus.Cancelled; }
}

public enum CheckoutStatus { Draft, Submitted, Cancelled }
EOF

cat > src/Domain/CheckoutManager.cs <<'EOF'
namespace Sample.Domain;

public class CheckoutManager
{
    public Checkout Build(string customerCode) => new() { CustomerCode = customerCode };
    public void CancelOrder(Checkout order) => order.Cancel();
}
EOF

cat > src/Api/Endpoints/CreateCheckoutEndpoint.cs <<'EOF'
using FastEndpoints;
namespace Sample.Api;

public class CreateCheckoutEndpoint : Endpoint<CreateCheckoutRequest>
{
    public override void Configure()
    {
        Post("/api/checkout");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CreateCheckoutRequest req, CancellationToken ct)
    {
        var order = new CheckoutManager().Build(req.CustomerCode);
        await SendOkAsync(order, ct);
    }
}

public class CreateCheckoutRequest { public string CustomerCode { get; set; } = ""; }
EOF

# Trap: concatenated raw SQL. No named call to Checkout in the signature —
# only historical coupling will surface it.
cat > src/Infrastructure/CheckoutRepository.cs <<'EOF'
namespace Sample.Infrastructure;

public class CheckoutRepository
{
    public void Purge(string code)
    {
        Db.Database.ExecuteSqlRaw("DELETE FROM Checkouts WHERE CustomerCode = '" + code + "'");
    }
}
EOF

cat > tests/Domain.Tests/CheckoutTests.cs <<'EOF'
public class CheckoutTests
{
    [Fact]
    public void Cancel_sets_status()
    {
        var o = new Checkout();
        o.Cancel();
    }
}
EOF

cat > app/Http/Controllers/PartnerController.php <<'EOF'
<?php
namespace App\Http\Controllers;

class PartnerController extends Controller
{
    public function sync()
    {
        Mail::to('alerts@example.com')->send(new SyncReport());
        return response()->json([]);
    }
}
EOF

git add -A && git commit -qm "init: domain, endpoint, repository, tests"

# History: four commits touching domain + endpoint + repository together.
# This is what creates the 100% coupling that static analysis cannot see.
for i in 1 2 3 4; do
  printf '// revision %s\n' "$i" >> src/Domain/Checkout.cs
  printf '// revision %s\n' "$i" >> src/Api/Endpoints/CreateCheckoutEndpoint.cs
  printf '// revision %s\n' "$i" >> src/Infrastructure/CheckoutRepository.cs
  git add -A && git commit -qm "feat: revision $i"
done

# Uncommitted destructive migration: used to exercise --diff mode and the
# escalation to BLOCKING.
cat > src/Infrastructure/Migrations/20260715_DropLegacyRef.cs <<'EOF'
public partial class DropLegacyRef : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropColumn(name: "LegacyRef", table: "Checkouts");
    }
}
EOF

# ------------------------------------------------------------ consumer repo
MOB="$WS/mobile-client"
mkdir -p "$MOB/src"
cd "$MOB"
git init -q && git config user.email dev@example.com && git config user.name "Dev Example"
cat > src/CheckoutApi.kt <<'EOF'
package com.example.app

class CheckoutApi {
    suspend fun fetch(): List<Checkout> =
        client.get("/api/checkout").body()
}
EOF
git add -A && git commit -qm "init: mobile KMP client"

echo "Fixture ready: $WS"
echo "  main repo : $API"
echo "  consumer  : $MOB"
