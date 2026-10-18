#!/usr/bin/env bash
# Proves the dashboard cannot send a non-GET request to GoHighLevel, and that the ONE sanctioned write path
# (Companion stage 2, lib/companion/ghlWrite.ts) reaches exactly three calls.
#
#  1. The only fetch() to services.leadconnectorhq.com is in lib/ghl/client.ts,
#     inside ghlRequest, which throws for any non-GET when ENABLE_WRITEBACK is off.
#  2. ENABLE_WRITEBACK is a literal `false` (not read from env).
#  3. No non-GET request literal exists outside the dormant modules.
#  6. GHL_BASE_URL is imported only by lib/ghl/client.ts and lib/companion/ghlWrite.ts.
#  7. No non-GET method literal exists in any file that touches GHL, outside lib/companion/ghlWrite.ts and the
#     two dormant modules.
#  8. lib/companion/ghlWrite.ts allow-lists exactly three paths (PUT /opportunities/{id},
#     PUT /calendars/events/appointments/{eventId}, POST /contacts/{contactId}/notes), its executor calls
#     assertAllowed before any I/O, and it reads its OWN key (never ghl_api_token).
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

WRITE_MODULE="lib/companion/ghlWrite.ts"

echo "6. GHL_BASE_URL is imported only by lib/ghl/client.ts and $WRITE_MODULE:"
hits=$(grep -rln "GHL_BASE_URL" --include='*.ts' --include='*.tsx' lib app db scripts | grep -v "^lib/ghl/config.ts$" | grep -v "^lib/ghl/client.ts$" | grep -v "^$WRITE_MODULE$" || true)
[ -z "$hits" ] || fail "GHL_BASE_URL imported elsewhere:
$hits"
echo "   ✓"

echo "7. Non-GET method literals in files that touch GHL, outside $WRITE_MODULE and the dormant modules:"
ghl_files=$( (grep -rlE "ghl/(client|config)'|ghlRequest\(|companionWrite\(" --include='*.ts' --include='*.tsx' lib app db scripts; grep -lE "from '\./(client|config)'" lib/ghl/*.ts) | sort -u | grep -v "^$WRITE_MODULE$" | grep -v "^lib/ghl/mapping.ts$" | grep -v "^lib/ghl/sync.ts$" || true)
hits=""
for f in $ghl_files; do
  h=$(grep -nE "method: ['\"](POST|PUT|DELETE|PATCH)['\"]" "$f" || true)
  [ -z "$h" ] || hits="$hits
$f: $h"
done
[ -z "$hits" ] || fail "found a non-GET request literal outside the write module:$hits"
echo "   none ✓"

echo "8. $WRITE_MODULE allow-lists exactly the three Companion calls and guards before I/O:"
[ -f "$WRITE_MODULE" ] || fail "$WRITE_MODULE is missing"
n=$(grep -cE "^\s*\{ name: '(update_opportunity|update_appointment_status|add_contact_note)', method: '(PUT|POST)', pattern: new RegExp\(" "$WRITE_MODULE" || true)
[ "$n" = "3" ] || fail "expected exactly 3 allow-list entries, found $n"
grep -q "pattern: new RegExp(\`^/opportunities/\${ID}\$\`)" "$WRITE_MODULE" || fail "allow-list: PUT /opportunities/{id} pattern changed"
grep -q "pattern: new RegExp(\`^/calendars/events/appointments/\${ID}\$\`)" "$WRITE_MODULE" || fail "allow-list: PUT /calendars/events/appointments/{eventId} pattern changed"
grep -q "pattern: new RegExp(\`^/contacts/\${ID}/notes\$\`)" "$WRITE_MODULE" || fail "allow-list: POST /contacts/{contactId}/notes pattern changed"
paths=$(grep -oE "path: \`/[^\`]*\`" "$WRITE_MODULE" | sort -u)
expected=$(printf 'path: `/calendars/events/appointments/${id}`\npath: `/contacts/${id}/notes`\npath: `/opportunities/${oppId}`')
[ "$paths" = "$expected" ] || fail "the write module builds a path outside the three:
$paths"
# The executor's first statement is the allow-list check; the transport is used only after it.
exec_line=$(grep -n "export async function companionWrite" "$WRITE_MODULE" | cut -d: -f1)
assert_line=$(grep -n "const allowed = assertAllowed(req.method, req.path);" "$WRITE_MODULE" | cut -d: -f1)
fetch_line=$(grep -n "return transport(" "$WRITE_MODULE" | head -1 | cut -d: -f1)
[ -n "$exec_line" ] && [ -n "$assert_line" ] && [ -n "$fetch_line" ] || fail "companionWrite / assertAllowed / transport not found"
[ "$assert_line" -gt "$exec_line" ] && [ "$fetch_line" -gt "$assert_line" ] || fail "assertAllowed does not precede the transport in companionWrite"
grep -q "COMPANION_SETTING_KEYS.writeToken" "$WRITE_MODULE" || fail "the write module does not read its own key"
grep -q "ghl_api_token\|CREDENTIAL_KEYS.token" "$WRITE_MODULE" && fail "the write module references the read key" || true
echo "   3 entries · 3 paths · assertAllowed before transport · own key ✓"

echo
echo "✓ GoHighLevel is read-only for the dashboard and every sync (ENABLE_WRITEBACK off); the Companion's write path is $WRITE_MODULE and reaches exactly three calls."
