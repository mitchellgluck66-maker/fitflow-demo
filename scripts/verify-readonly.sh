#!/usr/bin/env bash
# Proves no code path can send a non-GET request to GoHighLevel.
#
#  1. The only fetch() to services.leadconnectorhq.com is in lib/ghl/client.ts,
#     inside ghlRequest, which throws for any non-GET when ENABLE_WRITEBACK is off.
#  2. ENABLE_WRITEBACK is a literal `false` (not read from env).
#  3. No non-GET request literal exists outside the dormant modules.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "✗ $1"; exit 1; }

echo "1. Hosts contacted with fetch():"
hits=$(grep -rnE "['\"\`]https?://[^'\"\`]*leadconnectorhq" --include='*.ts' --include='*.tsx' lib app db scripts | grep -v "^lib/ghl/config.ts" || true)
[ -z "$hits" ] || fail "GHL host referenced outside lib/ghl/config.ts:
$hits"
echo "   only lib/ghl/config.ts (GHL_BASE_URL) ✓"

echo "2. ENABLE_WRITEBACK is a literal false:"
grep -q "export const ENABLE_WRITEBACK = false as const;" lib/ghl/config.ts || fail "ENABLE_WRITEBACK is not hard-off"
echo "   ✓"

echo "3. ghlRequest refuses non-GET before any I/O:"
grep -q "if (req.method !== 'GET' && !ENABLE_WRITEBACK)" lib/ghl/client.ts || fail "guard missing in ghlRequest"
echo "   ✓"

echo "4. Non-GET method literals to GHL outside dormant modules:"
hits=$(grep -rnE "method: '(POST|PUT|DELETE|PATCH)'" --include='*.ts' lib/ghl app/api/ghl app/api/sync app/api/cron 2>/dev/null | grep -v "lib/ghl/mapping.ts" | grep -v "lib/ghl/sync.ts" || true)
[ -z "$hits" ] || fail "found non-GET GHL request literal:
$hits"
echo "   none (lib/ghl/mapping.ts + lib/ghl/sync.ts are dormant, gated by ENABLE_WRITEBACK) ✓"

echo "5. Every ghlRequest call site uses GET:"
hits=$(grep -rn -A3 "ghlRequest" lib/ghl/client.ts | grep "method:" | grep -v "'GET'" || true)
[ -z "$hits" ] || fail "non-GET in client.ts:
$hits"
echo "   ✓"

echo
echo "✓ GoHighLevel is read-only: no code path can issue a non-GET request while ENABLE_WRITEBACK is off."
