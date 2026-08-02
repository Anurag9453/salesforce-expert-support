#!/usr/bin/env bash
# Phase 2 exit criterion, over real HTTP.
#
# An expert can be created, submitted, approved by an admin — and is eligible
# for matching at no point before that. Plus: authorization is enforced
# server-side, not by hiding UI.
set -uo pipefail

REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
BASE="${BASE:-http://localhost:3000}"
C_JAR=$(mktemp); A_JAR=$(mktemp)
STAMP=$(date +%s)
CUST="cust-${STAMP}@example.com"
ADMIN="admin-${STAMP}@example.com"
PW="a-very-long-test-password"

pass=0; fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n     got: %s\n' "$1" "$2"; fail=$((fail+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected $3)" "$2"; fi }
head1(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const p=process.argv[1].split(".");let v=o;for(const k of p)v=v?.[k];console.log(v===undefined?"undefined":typeof v==="object"?JSON.stringify(v):String(v));}catch(e){console.log("PARSE_ERROR")}})' "$1"; }

signup() { curl -s -c "$2" -X POST "$BASE/api/auth/sign-up/email" -H 'content-type: application/json' \
  -d "{\"email\":\"$1\",\"password\":\"$PW\",\"name\":\"$3\"}"; }

head1 "Setup — two accounts"
signup "$CUST" "$C_JAR" "Customer" >/dev/null
signup "$ADMIN" "$A_JAR" "Admin" >/dev/null
ok "registered customer and admin-to-be"

# Admin role is granted out of band. There is deliberately no self-service path.
(cd "$REPO/packages/db" && pnpm exec dotenv -e ../../.env -- node scripts/grant-role.mjs "$ADMIN" ADMIN) >/dev/null 2>&1
ok "granted ADMIN via the out-of-band script"

head1 "Requirement 1 — one account, two roles"
ME=$(curl -s -b "$C_JAR" "$BASE/api/v1/me")
check "new account starts as CUSTOMER only" "$(echo "$ME" | jget data.roles)" '["CUSTOMER"]'
check "no expert application yet" "$(echo "$ME" | jget data.expert)" "null"

APP=$(curl -s -b "$C_JAR" -X POST "$BASE/api/v1/expert-application")
APP_ID=$(echo "$APP" | jget data.id)
check "started application, status DRAFT" "$(echo "$APP" | jget data.status)" "DRAFT"

ME=$(curl -s -b "$C_JAR" "$BASE/api/v1/me")
check "same account is now dual-role" "$(echo "$ME" | jget data.roles)" '["CUSTOMER","EXPERT"]'
check "user id unchanged (no second identity)" "$(echo "$ME" | jget data.userId)" "$(curl -s -b "$C_JAR" "$BASE/api/v1/me" | jget data.userId)"

APP2=$(curl -s -b "$C_JAR" -X POST "$BASE/api/v1/expert-application")
check "applying twice returns the same application" "$(echo "$APP2" | jget data.id)" "$APP_ID"

head1 "Requirement 2 — EXPERT role alone is not eligibility"
check "DRAFT is not eligible" "$(echo "$APP" | jget data.eligibleForMatching)" "false"
ME=$(curl -s -b "$C_JAR" "$BASE/api/v1/me")
check "session reports not eligible" "$(echo "$ME" | jget data.expert.eligibleForMatching)" "false"
check "no expert_workspace:access permission" \
  "$(echo "$ME" | jget data.permissions | grep -c expert_workspace || true)" "0"
# Assert the redirect itself, not just that *something* rendered — a 200 would
# also be returned by the workspace, which is exactly what must not happen.
WS_CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$C_JAR" "$BASE/expert")
WS_DEST=$(curl -s -o /dev/null -w '%{redirect_url}' -b "$C_JAR" "$BASE/expert")
check "/expert does not render for an unapproved expert" "$WS_CODE" "307"
check "/expert redirects to the application" "${WS_DEST##*/}" "expert-application"

head1 "Submit — completeness enforced server-side"
BAD=$(curl -s -b "$C_JAR" -X POST "$BASE/api/v1/expert-application/submit")
check "empty application refused" "$(echo "$BAD" | jget error.code)" "VALIDATION_ERROR"
check "reports every missing field" "$(echo "$BAD" | jget error.fields | grep -c professionalSummary || true)" "1"

curl -s -b "$C_JAR" -X PATCH "$BASE/api/v1/expert-application" -H 'content-type: application/json' \
  -d '{"country":"IN","timezone":"Asia/Kolkata","yearsExperience":7,
       "professionalSummary":"Apex, LWC and integration work across ten Salesforce orgs, with a focus on governor limits and async patterns.",
       "languages":["en","hi"],"certifications":["Platform Developer I"],
       "acceptTerms":true,"acceptConfidentiality":true}' >/dev/null
ok "saved a complete draft"

SUB=$(curl -s -b "$C_JAR" -X POST "$BASE/api/v1/expert-application/submit")
check "submitted" "$(echo "$SUB" | jget data.status)" "SUBMITTED"
check "SUBMITTED is still not eligible" "$(echo "$SUB" | jget data.eligibleForMatching)" "false"

FROZEN=$(curl -s -b "$C_JAR" -X PATCH "$BASE/api/v1/expert-application" -H 'content-type: application/json' -d '{"professionalSummary":"sneaky edit"}')
check "cannot edit once with an admin" "$(echo "$FROZEN" | jget error.code)" "FORBIDDEN"

head1 "Requirement 4 — authorization is server-side"
DENY=$(curl -s -b "$C_JAR" "$BASE/api/v1/admin/experts")
check "customer cannot read the review queue" "$(echo "$DENY" | jget error.code)" "FORBIDDEN"

SELF=$(curl -s -b "$C_JAR" -X POST "$BASE/api/v1/admin/experts/$APP_ID/decision" \
  -H 'content-type: application/json' -d '{"decision":"approve","notes":"approving myself"}')
check "applicant cannot approve themselves" "$(echo "$SELF" | jget error.code)" "FORBIDDEN"

ANON=$(curl -s "$BASE/api/v1/admin/experts")
check "anonymous cannot read the queue" "$(echo "$ANON" | jget error.code)" "UNAUTHENTICATED"

STILL=$(curl -s -b "$C_JAR" "$BASE/api/v1/expert-application")
check "status untouched by the failed attempts" "$(echo "$STILL" | jget data.status)" "SUBMITTED"

head1 "Admin review"
Q=$(curl -s -b "$A_JAR" "$BASE/api/v1/admin/experts")
check "admin sees the queue" "$(echo "$Q" | jget data.items | grep -c "$APP_ID" || true)" "1"

NOREASON=$(curl -s -b "$A_JAR" -X POST "$BASE/api/v1/admin/experts/$APP_ID/decision" \
  -H 'content-type: application/json' -d '{"decision":"approve","notes":""}')
check "approval with no reason refused" "$(echo "$NOREASON" | jget error.code)" "VALIDATION_ERROR"

CLAIM=$(curl -s -b "$A_JAR" -X POST "$BASE/api/v1/admin/experts/$APP_ID/decision" \
  -H 'content-type: application/json' -d '{"decision":"claim"}')
check "claimed for review" "$(echo "$CLAIM" | jget data.status)" "UNDER_REVIEW"
check "UNDER_REVIEW is not eligible" "$(echo "$CLAIM" | jget data.eligibleForMatching)" "false"

APPROVE=$(curl -s -b "$A_JAR" -X POST "$BASE/api/v1/admin/experts/$APP_ID/decision" \
  -H 'content-type: application/json' -d '{"decision":"approve","notes":"Strong Apex and async depth."}')
check "approved" "$(echo "$APPROVE" | jget data.status)" "APPROVED"
check "APPROVED is eligible" "$(echo "$APPROVE" | jget data.eligibleForMatching)" "true"

ME=$(curl -s -b "$C_JAR" "$BASE/api/v1/me")
check "expert now has workspace access" \
  "$(echo "$ME" | jget data.permissions | grep -c expert_workspace || true)" "1"
check "still dual-role, customer access intact" "$(echo "$ME" | jget data.roles)" '["CUSTOMER","EXPERT"]'

head1 "Requirement 3 — audit trail"
H=$(curl -s -b "$A_JAR" "$BASE/api/v1/admin/experts/$APP_ID/history")
check "records the approval" "$(echo "$H" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).data;console.log(a.filter(e=>e.action==="expert.approved").length)})')" "1"
check "records who approved" "$(echo "$H" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=JSON.parse(s).data.find(x=>x.action==="expert.approved");console.log(e.after.reviewedByEmail)})')" "$ADMIN"
check "records the transition" "$(echo "$H" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=JSON.parse(s).data.find(x=>x.action==="expert.approved");console.log(e.before.status+"->"+e.after.status)})')" "UNDER_REVIEW->APPROVED"
check "records the reason" "$(echo "$H" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=JSON.parse(s).data.find(x=>x.action==="expert.approved");console.log(e.after.notes)})')" "Strong Apex and async depth."
check "full lifecycle present" "$(echo "$H" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.parse(s).data.map(e=>e.action).reverse().join(","))})')" \
  "expert_application.started,expert_application.submitted,expert.claimed,expert.approved"

head1 "Suspension revokes eligibility immediately"
SUS=$(curl -s -b "$A_JAR" -X POST "$BASE/api/v1/admin/experts/$APP_ID/decision" \
  -H 'content-type: application/json' -d '{"decision":"suspend","notes":"Quality concerns raised."}')
check "suspended" "$(echo "$SUS" | jget data.status)" "SUSPENDED"
check "no longer eligible" "$(echo "$SUS" | jget data.eligibleForMatching)" "false"
ME=$(curl -s -b "$C_JAR" "$BASE/api/v1/me")
check "workspace access revoked" \
  "$(echo "$ME" | jget data.permissions | grep -c expert_workspace || true)" "0"

REIN=$(curl -s -b "$A_JAR" -X POST "$BASE/api/v1/admin/experts/$APP_ID/decision" \
  -H 'content-type: application/json' -d '{"decision":"reinstate","notes":"Resolved after discussion."}')
check "reinstated and eligible again" "$(echo "$REIN" | jget data.eligibleForMatching)" "true"

head1 "Illegal transitions"
ILLEGAL=$(curl -s -b "$A_JAR" -X POST "$BASE/api/v1/admin/experts/$APP_ID/decision" \
  -H 'content-type: application/json' -d '{"decision":"approve","notes":"already approved"}')
check "APPROVED -> APPROVED refused" "$(echo "$ILLEGAL" | jget error.code)" "ILLEGAL_STATE_TRANSITION"

printf '\n\033[1m── e2e ──\033[0m\n  %d passed, %d failed\n' "$pass" "$fail"
rm -f "$C_JAR" "$A_JAR"
[ "$fail" -eq 0 ]
