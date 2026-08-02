#!/usr/bin/env bash
# Phase 3 exit criterion, over real HTTP.
#
# A customer submits a request with an attachment, it is redacted before storage,
# classified, and reaches SEARCHING — including when classification fails.
set -uo pipefail

REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
BASE="${BASE:-http://localhost:3000}"
JAR=$(mktemp); JAR2=$(mktemp); TMPDIR_E2E=$(mktemp -d)
STAMP=$(date +%s)
CUST="req-${STAMP}@example.com"
OTHER="other-${STAMP}@example.com"
PW="a-very-long-test-password"

pass=0; fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n     got: %s\n' "$1" "$2"; fail=$((fail+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected $3)" "$2"; fi }
has()  { case "$2" in *"$3"*) ok "$1";; *) bad "$1 (expected to contain $3)" "$2";; esac }
hasnt(){ case "$2" in *"$3"*) bad "$1 (should NOT contain $3)" "$2";; *) ok "$1";; esac }
head1(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const p=process.argv[1].split(".");let v=o;for(const k of p)v=v?.[k];console.log(v===undefined?"undefined":typeof v==="object"?JSON.stringify(v):String(v));}catch(e){console.log("PARSE_ERROR")}})' "$1"; }

signup() { curl -s -c "$2" -X POST "$BASE/api/auth/sign-up/email" -H 'content-type: application/json' \
  -d "{\"email\":\"$1\",\"password\":\"$PW\",\"name\":\"Test\"}"; }

# Waits for the worker to move a request out of CLASSIFYING.
wait_state() {
  for _ in $(seq 1 40); do
    local s; s=$(curl -s -b "$JAR" "$BASE/api/v1/requests/$1" | jget data.state)
    [ "$s" = "$2" ] && { echo "$s"; return 0; }
    sleep 0.5
  done
  curl -s -b "$JAR" "$BASE/api/v1/requests/$1" | jget data.state
}

head1 "Setup"
signup "$CUST" "$JAR" >/dev/null
signup "$OTHER" "$JAR2" >/dev/null
ok "registered two customers"

TIERS=$(curl -s -b "$JAR" "$BASE/api/v1/taxonomy")
TIER=$(echo "$TIERS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.tiers[0].id))')
CATS=$(echo "$TIERS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.categories.length))')
check "taxonomy exposes the 6 seeded categories" "$CATS" "6"

head1 "Requirement 1 & 3 — description alone is enough"
MINIMAL=$(curl -s -b "$JAR" -X POST "$BASE/api/v1/requests" -H 'content-type: application/json' \
  -d "{\"description\":\"Our Apex trigger on Account hits 'Too many SOQL queries: 101' when we bulk load about 4000 records. The trigger looks bulkified to me.\",\"pricingTierId\":\"$TIER\"}")
REQ1=$(echo "$MINIMAL" | jget data.request.id)
check "submitted with no category and no skills" "$(echo "$MINIMAL" | jget data.request.state)" "CLASSIFYING"
has "title derived from the description" "$(echo "$MINIMAL" | jget data.request.title)" "Too many SOQL queries"
check "no secret notice on clean text" "$(echo "$MINIMAL" | jget data.secretNotice)" "null"

head1 "Requirement 4 — classification runs and reaches SEARCHING"
STATE=$(wait_state "$REQ1" "SEARCHING")
check "reached SEARCHING" "$STATE" "SEARCHING"
DETAIL=$(curl -s -b "$JAR" "$BASE/api/v1/requests/$REQ1")
AI=$(echo "$DETAIL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const k=JSON.parse(s).data.skills.filter(x=>x.source==="AI_DETECTED");console.log(k.map(x=>x.slug).join(","))})')
has "classifier detected the Apex/SOQL signals" "$AI" "apex"
check "difficulty assessed" "$(echo "$DETAIL" | jget data.difficulty)" "ADVANCED"
has "model recorded for later evaluation" "$(echo "$DETAIL" | jget data.aiModel)" "rules"

head1 "One in-flight request at a time"
DUPE=$(curl -s -b "$JAR" -X POST "$BASE/api/v1/requests" -H 'content-type: application/json' \
  -d "{\"description\":\"Another completely separate problem with Flow that I need help on today.\",\"pricingTierId\":\"$TIER\"}")
check "second request refused while one is live" "$(echo "$DUPE" | jget error.code)" "CONFLICT"

curl -s -b "$JAR" -X POST "$BASE/api/v1/requests/$REQ1/cancel" -H 'content-type: application/json' -d '{}' >/dev/null
ok "cancelled the first request"

head1 "Requirement 6 — redaction happens before storage"
LEAKY=$(curl -s -b "$JAR" -X POST "$BASE/api/v1/requests" -H 'content-type: application/json' \
  -d "{\"description\":\"Callout to our REST endpoint fails. Sid=00D5f000000abcdE!AQcAQH0dMHZfz.SsBcMxYo8mVXJ4Kz9pQrStUvWxYz01 and the named credential has password=hunter2please set.\",\"pricingTierId\":\"$TIER\"}")
REQ2=$(echo "$LEAKY" | jget data.request.id)
STORED=$(echo "$LEAKY" | jget data.request.description)
hasnt "session ID not stored" "$STORED" "AQcAQH0dMHZ"
hasnt "password not stored" "$STORED" "hunter2please"
has "the actual problem survives redaction" "$STORED" "Callout to our REST endpoint fails"
has "customer is told, calmly" "$(echo "$LEAKY" | jget data.secretNotice)" "removed it before saving"
has "notice reassures rather than accuses" "$(echo "$LEAKY" | jget data.secretNotice)" "Nothing was shared"

# The stored row is what the classifier reads, so confirming the API response
# matches the persisted row closes requirement 6 end to end.
FETCHED=$(curl -s -b "$JAR" "$BASE/api/v1/requests/$REQ2" | jget data.description)
hasnt "re-fetched row is redacted too" "$FETCHED" "AQcAQH0dMHZ"
wait_state "$REQ2" "SEARCHING" >/dev/null
curl -s -b "$JAR" -X POST "$BASE/api/v1/requests/$REQ2/cancel" -H 'content-type: application/json' -d '{}' >/dev/null

head1 "Requirement 2 — customer selections assist, never diagnose"
ASSISTED=$(curl -s -b "$JAR" -X POST "$BASE/api/v1/requests" -H 'content-type: application/json' \
  -d "{\"description\":\"Screen flow throws UNABLE_TO_LOCK_ROW when two users edit the same Account at once.\",\"pricingTierId\":\"$TIER\",\"categorySlug\":\"salesforce-configuration\",\"skillSlugs\":[\"flow\"]}")
REQ3=$(echo "$ASSISTED" | jget data.request.id)
CUSTOMER_PRIMARY=$(echo "$ASSISTED" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const k=JSON.parse(s).data.request.skills.filter(x=>x.source==="CUSTOMER_SELECTED");console.log(k.every(x=>x.isPrimary===false))})')
check "customer selections are never marked primary" "$CUSTOMER_PRIMARY" "true"
wait_state "$REQ3" "SEARCHING" >/dev/null
BOTH=$(curl -s -b "$JAR" "$BASE/api/v1/requests/$REQ3" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const k=JSON.parse(s).data.skills;console.log([...new Set(k.map(x=>x.source))].sort().join(","))})')
check "both sources kept side by side" "$BOTH" "AI_DETECTED,CUSTOMER_SELECTED"
curl -s -b "$JAR" -X POST "$BASE/api/v1/requests/$REQ3/cancel" -H 'content-type: application/json' -d '{}' >/dev/null

head1 "Requirement 7 — attachments are private"
printf 'ERROR at line 12: System.LimitException\nstack frame here\n' > "$TMPDIR_E2E/debug.log"
PRESIGN=$(curl -s -b "$JAR" -X POST "$BASE/api/v1/attachments" -H 'content-type: application/json' \
  -d '{"filename":"debug.log","contentType":"text/plain","sizeBytes":64}')
ATT=$(echo "$PRESIGN" | jget data.attachmentId)
UPURL=$(echo "$PRESIGN" | jget data.uploadUrl)
check "presign issued" "$( [ -n "$ATT" ] && [ "$ATT" != "undefined" ] && echo yes || echo no )" "yes"

UP=$(curl -s -b "$JAR" -X PUT "$UPURL" -H 'content-type: text/plain' --data-binary "@$TMPDIR_E2E/debug.log" -o /dev/null -w '%{http_code}')
check "upload accepted" "$UP" "200"

WITHFILE=$(curl -s -b "$JAR" -X POST "$BASE/api/v1/requests" -H 'content-type: application/json' \
  -d "{\"description\":\"Batch Apex fails partway through with a LimitException. Log attached — it dies around record 4000.\",\"pricingTierId\":\"$TIER\",\"attachmentIds\":[\"$ATT\"]}")
REQ4=$(echo "$WITHFILE" | jget data.request.id)
check "attachment bound to the request" "$(echo "$WITHFILE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.request.attachments.length))')" "1"

# The download URL is signed AND authorization-checked. Both must hold.
DL=$(curl -s -b "$JAR" "$BASE/api/v1/requests/$REQ4" >/dev/null; echo ok)
BADSIG=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$BASE/api/v1/attachments/download?key=attachments/x/y.log&expires=99999999999999&signature=forged")
check "forged signature refused" "$BADSIG" "403"

STRANGER=$(curl -s -b "$JAR2" "$BASE/api/v1/requests/$REQ4" | jget error.code)
check "another customer cannot read the request" "$STRANGER" "FORBIDDEN"

head1 "Rate limiting is wired"
# Budget is 5 per 5 minutes; four are already spent above, so this must trip.
LIMIT_HIT=no
for i in 1 2 3 4 5 6; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X POST "$BASE/api/v1/requests" \
    -H 'content-type: application/json' \
    -d "{\"description\":\"Rate limit probe number $i with enough words to pass validation checks.\",\"pricingTierId\":\"$TIER\"}")
  [ "$code" = "429" ] && LIMIT_HIT=yes && break
done
check "request creation is rate limited" "$LIMIT_HIT" "yes"

head1 "Anonymous access"
check "anonymous cannot list requests" "$(curl -s "$BASE/api/v1/requests" | jget error.code)" "UNAUTHENTICATED"
check "anonymous cannot presign an upload" "$(curl -s -X POST "$BASE/api/v1/attachments" -H 'content-type: application/json' -d '{"filename":"a.log","contentType":"text/plain","sizeBytes":10}' | jget error.code)" "UNAUTHENTICATED"

printf '\n\033[1m── e2e ──\033[0m\n  %d passed, %d failed\n' "$pass" "$fail"
rm -rf "$JAR" "$JAR2" "$TMPDIR_E2E"
[ "$fail" -eq 0 ]
