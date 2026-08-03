#!/usr/bin/env bash
# Phase 5 exit criterion, over real HTTP.
#
# A customer submits a Salesforce problem; the engine ranks the available experts;
# the best one is offered the work and accepts; the customer's request reflects
# the assignment. Plus: the primary-skill floor disqualifies the wrong expert,
# declines and timeouts are recorded distinctly, the 60-second window is durable,
# and manual dispatch never bypasses consent.
#
# The 60-second offer window makes the timeout path slow. Run the servers with a
# short window to exercise it:
#
#   OFFER_WINDOW_SECONDS=20 pnpm dev
#   pnpm e2e:phase5
#
# 20s rather than 8s: this script makes several round-trips per assertion, and a
# window short enough to expire mid-scenario would make the *other* sections
# flaky for reasons that have nothing to do with what they test.
#
# With the default 60s the timeout section is skipped rather than faked.
set -uo pipefail

REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
BASE="${BASE:-http://localhost:3000}"
C_JAR=$(mktemp); A_JAR=$(mktemp); C_JAR_MAIN=""
E1_JAR=$(mktemp); E2_JAR=$(mktemp); E3_JAR=$(mktemp)
STAMP=$(date +%s)
CUST="m-cust-${STAMP}@example.com"
ADMIN="m-admin-${STAMP}@example.com"
PW="a-very-long-test-password"

pass=0; fail=0; skipped=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n     got: %s\n' "$1" "$2"; fail=$((fail+1)); }
skip() { printf '  \033[33m–\033[0m %s\n' "$1"; skipped=$((skipped+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected $3)" "$2"; fi }
has()  { case "$2" in *"$3"*) ok "$1";; *) bad "$1 (expected to contain $3)" "$2";; esac }
hasnt(){ case "$2" in *"$3"*) bad "$1 (should NOT contain $3)" "$2";; *) ok "$1";; esac }
head1(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const p=process.argv[1].split(".");let v=o;for(const k of p)v=v?.[k];console.log(v===undefined?"undefined":typeof v==="object"?JSON.stringify(v):String(v));}catch(e){console.log("PARSE_ERROR")}})' "$1"; }
jnode(){ node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const d=JSON.parse(s).data;console.log($1)}catch(e){console.log('ERR')}})"; }

signup() { curl -s -c "$2" -X POST "$BASE/api/auth/sign-up/email" -H 'content-type: application/json' \
  -d "{\"email\":\"$1\",\"password\":\"$PW\",\"name\":\"T\"}"; }

# Creates an approved expert with the given skills.
#   make_expert <jar> <email> <skill:LEVEL:YEARS> ...
make_expert() {
  local jar=$1 email=$2; shift 2
  signup "$email" "$jar" >/dev/null
  local id
  id=$(curl -s -b "$jar" -X POST "$BASE/api/v1/expert-application" | jget data.id)
  curl -s -b "$jar" -X PATCH "$BASE/api/v1/expert-application" -H 'content-type: application/json' \
    -d '{"country":"IN","timezone":"Asia/Kolkata","yearsExperience":8,
         "professionalSummary":"Apex, integration and CPQ work across a dozen Salesforce orgs, mostly untangling governor limits and async jobs written in a hurry.",
         "languages":["en"],"certifications":["Platform Developer II"],
         "acceptTerms":true,"acceptConfidentiality":true}' >/dev/null
  curl -s -b "$jar" -X POST "$BASE/api/v1/expert-application/submit" >/dev/null
  curl -s -b "$A_JAR" -X POST "$BASE/api/v1/admin/experts/$id/decision" \
    -H 'content-type: application/json' -d '{"decision":"claim"}' >/dev/null
  curl -s -b "$A_JAR" -X POST "$BASE/api/v1/admin/experts/$id/decision" \
    -H 'content-type: application/json' -d '{"decision":"approve","notes":"Checked references."}' >/dev/null
  for spec in "$@"; do
    local slug level years
    slug=${spec%%:*}; level=$(echo "$spec" | cut -d: -f2); years=$(echo "$spec" | cut -d: -f3)
    curl -s -b "$jar" -X PUT "$BASE/api/v1/expert/skills" -H 'content-type: application/json' \
      -d "{\"skillSlug\":\"$slug\",\"proficiencyLevel\":\"$level\",\"yearsExperience\":$years}" >/dev/null
  done
  curl -s -b "$jar" -X PUT "$BASE/api/v1/expert/availability" -H 'content-type: application/json' \
    -d '{"available":true}' >/dev/null
  echo "$id"
}

wait_state() {
  for _ in $(seq 1 60); do
    local s; s=$(curl -s -b "$C_JAR" "$BASE/api/v1/requests/$1" | jget data.state)
    [ "$s" = "$2" ] && { echo "$s"; return 0; }
    sleep 0.5
  done
  curl -s -b "$C_JAR" "$BASE/api/v1/requests/$1" | jget data.state
}

submit() {
  curl -s -b "$C_JAR" -X POST "$BASE/api/v1/requests" -H 'content-type: application/json' \
    -d "{\"description\":\"$1\",\"pricingTierId\":\"$TIER\"}"
}

# A fresh customer per scenario. One in-flight request per customer is a
# deliberate Phase 3 rule, so reusing one account would make every scenario after
# the first fail on a CONFLICT that has nothing to do with matching.
new_customer() {
  local jar=$1 email="m-c${2}-${STAMP}@example.com"
  signup "$email" "$jar" >/dev/null
  echo "$email"
}

cancel_live() {
  local id; id=$(curl -s -b "$C_JAR" "$BASE/api/v1/requests" | jnode "d.items.find(r=>['CREATED','CLASSIFYING','SEARCHING','OFFERED'].includes(r.state))?.id ?? ''")
  [ -n "$id" ] && curl -s -b "$C_JAR" -X POST "$BASE/api/v1/requests/$id/cancel" -H 'content-type: application/json' -d '{}' >/dev/null
  return 0
}

# ── Setup ────────────────────────────────────────────────────────────────────

head1 "Setup"
signup "$CUST" "$C_JAR" >/dev/null
signup "$ADMIN" "$A_JAR" >/dev/null
(cd "$REPO/packages/db" && pnpm exec dotenv -e ../../.env -- node scripts/grant-role.mjs "$ADMIN" ADMIN) >/dev/null 2>&1
ok "customer and admin registered"

TIER=$(curl -s -b "$C_JAR" "$BASE/api/v1/taxonomy" | jnode "d.tiers[0].id")

# The specialist: deep in Apex, the thing the request will be about.
E1=$(make_expert "$E1_JAR" "m-deep-${STAMP}@example.com" "apex:EXPERT:8" "triggers:ADVANCED:7" "batch-apex:ADVANCED:6")
# The competent second choice.
E2=$(make_expert "$E2_JAR" "m-good-${STAMP}@example.com" "apex:ADVANCED:5" "triggers:ADVANCED:5" "batch-apex:ADVANCED:4")
# The generalist: strong everywhere except the one thing that matters.
E3=$(make_expert "$E3_JAR" "m-general-${STAMP}@example.com" "apex:BEGINNER:1" "flow:EXPERT:12" "reports:EXPERT:10")
ok "three approved experts, all available"
check "the specialist is eligible" "$(curl -s -b "$E1_JAR" "$BASE/api/v1/expert/availability" | jget data.eligibility.eligible)" "true"

# ── The core loop ────────────────────────────────────────────────────────────

head1 "Requirement 17 — the loop, end to end"

REQ=$(submit "Our Apex trigger on Account hits Too many SOQL queries: 101 when we bulk load about 4000 records. The trigger looks bulkified but it still dies around record 3800.")
REQ_ID=$(echo "$REQ" | jget data.request.id)
ok "customer submitted a problem, choosing no expert"

STATE=$(wait_state "$REQ_ID" "OFFERED")
check "classified, matched, and offered" "$STATE" "OFFERED"

OFFER=$(curl -s -b "$E1_JAR" "$BASE/api/v1/expert/offer")
check "the offer went to the Apex specialist" "$(echo "$OFFER" | jget data.attemptId | cut -c1-3)" "cms"
has "the offer names the problem" "$(echo "$OFFER" | jget data.title)" "SOQL"
check "and states the payout" "$(echo "$OFFER" | jnode "d.payoutCents > 0")" "true"
check "with a countdown to a stored deadline" "$(echo "$OFFER" | jnode "d.secondsRemaining > 0 && d.offerExpiresAt.length > 0")" "true"
check "algorithmic, not manual" "$(echo "$OFFER" | jget data.origin)" "ALGORITHMIC"

check "the generalist got nothing" "$(curl -s -b "$E3_JAR" "$BASE/api/v1/expert/offer" | jget data)" "null"
check "and neither did the second choice" "$(curl -s -b "$E2_JAR" "$BASE/api/v1/expert/offer" | jget data)" "null"

ACCEPT=$(curl -s -b "$E1_JAR" -X POST "$BASE/api/v1/expert/offer" -H 'content-type: application/json' -d '{"decision":"accept"}')
check "the expert accepted" "$(echo "$ACCEPT" | jget data.status)" "ACCEPTED"
check "the request reflects the assignment" "$(wait_state "$REQ_ID" "ACCEPTED")" "ACCEPTED"

DETAIL=$(curl -s -b "$C_JAR" "$BASE/api/v1/requests/$REQ_ID")
check "the customer is told who is helping" "$(echo "$DETAIL" | jnode "d.matchedExpert !== null")" "true"
# §39 — never a directory. The disclosure must not carry an identity.
hasnt "and is NOT given the expert's identity" "$(echo "$DETAIL" | jget data.matchedExpert)" "@example.com"
hasnt "nor an expert id to look up" "$(echo "$DETAIL" | jget data.matchedExpert)" "expertProfileId"

# ── Requirements 2 and 4 ─────────────────────────────────────────────────────

head1 "Requirements 2 & 4 — the floor, and the audit that explains it"

AUDIT=$(curl -s -b "$A_JAR" "$BASE/api/v1/admin/requests/$REQ_ID/matching")
check "the admin can read the whole search" "$(echo "$AUDIT" | jnode "d.runs.length >= 1")" "true"
check "the winner is recorded with a rank" "$(echo "$AUDIT" | jnode "d.runs.flatMap(r=>r.attempts).find(a=>a.status==='ACCEPTED').rank")" "1"
# Recomputes the total from the persisted components AND the persisted weight
# snapshot. If those three cannot be made to agree, requirement 4 is not met —
# an audit row that does not reproduce its own conclusion explains nothing.
RECOMPUTE=$(cat <<'JS'
const a = d.runs.flatMap(r => r.attempts).find(x => x.status === 'ACCEPTED');
const w = d.runs.find(r => r.attempts.some(x => x.id === a.id)).weightsSnapshot;
const total = w.skill * a.scores.skill + w.rating * a.scores.rating
  + w.experience * a.scores.experience + w.fairness * a.scores.fairness
  + w.reliability * a.scores.reliability;
console.log(String(Math.abs(total - a.scores.final) < 0.002));
JS
)
check "and score components that reproduce the total, using the stored weights" \
  "$(echo "$AUDIT" | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const d=JSON.parse(s).data;$RECOMPUTE})")" \
  "true"
# The Copado case, over HTTP: the generalist is excluded, and the audit says why.
check "the generalist was excluded, not merely outranked" \
  "$(echo "$AUDIT" | jnode "d.runs[0].attempts.find(a=>a.expertProfileId==='$E3').status")" "EXCLUDED"
has "for being below the primary-skill floor" \
  "$(echo "$AUDIT" | jnode "JSON.stringify(d.runs[0].attempts.find(a=>a.expertProfileId==='$E3').exclusionReasons)")" \
  "PRIMARY_BELOW_FLOOR"
check "the second choice was ranked but never offered" \
  "$(echo "$AUDIT" | jnode "d.runs[0].attempts.find(a=>a.expertProfileId==='$E2').status")" "SUPERSEDED"
has "the run snapshots the floor that was in force" \
  "$(echo "$AUDIT" | jnode "JSON.stringify(d.runs[0].filtersApplied)")" "ADVANCED"
has "and the weights" "$(echo "$AUDIT" | jnode "JSON.stringify(d.runs[0].weightsSnapshot)")" "skill"

check "a non-admin cannot read the audit" \
  "$(curl -s -b "$E1_JAR" "$BASE/api/v1/admin/requests/$REQ_ID/matching" | jget error.code)" "FORBIDDEN"
check "and neither can the customer" \
  "$(curl -s -b "$C_JAR" "$BASE/api/v1/admin/requests/$REQ_ID/matching" | jget error.code)" "FORBIDDEN"

# ── Requirements 9 and 10 ────────────────────────────────────────────────────

head1 "Requirements 9 & 10 — decline, with the offer moving on"

# A second customer: the first one's request is ACCEPTED, and one in-flight
# request per customer is a Phase 3 rule.
C2_JAR=$(mktemp); new_customer "$C2_JAR" 2 >/dev/null
C_JAR_MAIN=$C_JAR; C_JAR=$C2_JAR
# The specialist is now IN_SESSION, so the next request should reach E2.
REQ2=$(submit "A second unrelated Apex problem: our batch job silently stops after 200 batches and we cannot see why in the logs.")
REQ2_ID=$(echo "$REQ2" | jget data.request.id)
check "offered to the next-best expert" "$(wait_state "$REQ2_ID" "OFFERED")" "OFFERED"
OFFER2=$(curl -s -b "$E2_JAR" "$BASE/api/v1/expert/offer")
check "which is the second choice" "$(echo "$OFFER2" | jnode "d.supportRequestId === '$REQ2_ID'")" "true"

DECLINE=$(curl -s -b "$E2_JAR" -X POST "$BASE/api/v1/expert/offer" -H 'content-type: application/json' \
  -d '{"decision":"decline","reason":"TOO_COMPLEX","note":"This needs someone who has debugged Batchable chaining."}')
check "declined with a structured reason" "$(echo "$DECLINE" | jget data.status)" "DECLINED"
check "the expert is free again" "$(curl -s -b "$E2_JAR" "$BASE/api/v1/expert/availability" | jget data.availabilityStatus)" "AVAILABLE"

AUDIT2=$(curl -s -b "$A_JAR" "$BASE/api/v1/admin/requests/$REQ2_ID/matching")
check "the decline is recorded as a decline" \
  "$(echo "$AUDIT2" | jnode "d.runs.flatMap(r=>r.attempts).find(a=>a.expertProfileId==='$E2').status")" "DECLINED"
check "with its reason" \
  "$(echo "$AUDIT2" | jnode "d.runs.flatMap(r=>r.attempts).find(a=>a.expertProfileId==='$E2').declineReason")" "TOO_COMPLEX"

head1 "A decline needs no reason"
cancel_live
REQ3=$(submit "Third Apex question, about a trigger recursion guard that is not preventing re-entry on update.")
REQ3_ID=$(echo "$REQ3" | jget data.request.id)
wait_state "$REQ3_ID" "OFFERED" >/dev/null
BARE=$(curl -s -b "$E2_JAR" -X POST "$BASE/api/v1/expert/offer" -H 'content-type: application/json' -d '{"decision":"decline"}')
check "declined with nothing attached" "$(echo "$BARE" | jget data.status)" "DECLINED"
check "and no reason was invented" \
  "$(curl -s -b "$A_JAR" "$BASE/api/v1/admin/requests/$REQ3_ID/matching" | jnode "String(d.runs.flatMap(r=>r.attempts).find(a=>a.expertProfileId==='$E2' && a.status==='DECLINED').declineReason)")" \
  "null"
check "an expert who declined is never re-offered the same request" \
  "$(curl -s -b "$E2_JAR" "$BASE/api/v1/expert/offer" | jnode "String(Boolean(d && d.supportRequestId === '$REQ3_ID'))")" "false"

# ── Requirements 12 and 13 ───────────────────────────────────────────────────

head1 "Requirements 12 & 13 — manual dispatch, consent intact"

cancel_live
C3_JAR=$(mktemp); new_customer "$C3_JAR" 3 >/dev/null
C_JAR=$C3_JAR
REQ4=$(submit "Fourth Apex problem: a queueable chain is hitting the async job limit under load and we need to restructure it.")
REQ4_ID=$(echo "$REQ4" | jget data.request.id)
wait_state "$REQ4_ID" "OFFERED" >/dev/null

CANDS=$(curl -s -b "$A_JAR" "$BASE/api/v1/admin/requests/$REQ4_ID/dispatch")
check "the admin sees the candidates the algorithm considered" "$(echo "$CANDS" | jnode "d.length >= 2")" "true"
check "with the excluded ones marked unassignable" \
  "$(echo "$CANDS" | jnode "String(d.find(c=>c.expertProfileId==='$E3').assignable)")" "false"

NOREASON=$(curl -s -b "$A_JAR" -X POST "$BASE/api/v1/admin/requests/$REQ4_ID/dispatch" \
  -H 'content-type: application/json' -d "{\"mode\":\"assign\",\"expertProfileId\":\"$E2\",\"reason\":\"\"}")
check "manual dispatch with no reason refused" "$(echo "$NOREASON" | jget error.code)" "VALIDATION_ERROR"

NOTADMIN=$(curl -s -b "$E1_JAR" -X POST "$BASE/api/v1/admin/requests/$REQ4_ID/dispatch" \
  -H 'content-type: application/json' -d "{\"mode\":\"assign\",\"expertProfileId\":\"$E2\",\"reason\":\"me\"}")
check "and an expert cannot dispatch to themselves" "$(echo "$NOTADMIN" | jget error.code)" "FORBIDDEN"

# Force Assign to the expert the algorithm permanently excluded.
FORCE=$(curl -s -b "$A_JAR" -X POST "$BASE/api/v1/admin/requests/$REQ4_ID/dispatch" \
  -H 'content-type: application/json' \
  -d "{\"mode\":\"force\",\"expertProfileId\":\"$E3\",\"reason\":\"Spoke to them directly; they built this org's async framework.\"}")
check "force-assigned over the competence rules" "$(echo "$FORCE" | jget data.origin)" "ADMIN_FORCE_ASSIGN"
# The rule the user overruled §C5 on: consent is not the admin's to give.
check "the request is OFFERED, not ACCEPTED" "$(curl -s -b "$C_JAR" "$BASE/api/v1/requests/$REQ4_ID" | jget data.state)" "OFFERED"
check "and nobody is assigned yet" "$(curl -s -b "$C_JAR" "$BASE/api/v1/requests/$REQ4_ID" | jnode "String(d.matchedExpert)")" "null"

FORCED_OFFER=$(curl -s -b "$E3_JAR" "$BASE/api/v1/expert/offer")
check "the force-assigned expert has a real offer" "$(echo "$FORCED_OFFER" | jnode "d.supportRequestId === '$REQ4_ID'")" "true"
check "labelled as sent by our team" "$(echo "$FORCED_OFFER" | jget data.origin)" "ADMIN_FORCE_ASSIGN"
has "carrying the operator's reason" "$(echo "$FORCED_OFFER" | jget data.adminNote)" "async framework"

# And they can still say no.
DECLINE_FORCED=$(curl -s -b "$E3_JAR" -X POST "$BASE/api/v1/expert/offer" -H 'content-type: application/json' \
  -d '{"decision":"decline","reason":"NOT_MY_EXPERTISE"}')
check "even a force-assigned expert may decline" "$(echo "$DECLINE_FORCED" | jget data.status)" "DECLINED"

AUDIT4=$(curl -s -b "$A_JAR" "$BASE/api/v1/admin/requests/$REQ4_ID/matching")
check "the manual attempt is distinguishable forever" \
  "$(echo "$AUDIT4" | jnode "d.runs.flatMap(r=>r.attempts).find(a=>a.origin==='ADMIN_FORCE_ASSIGN').origin")" "ADMIN_FORCE_ASSIGN"
check "with no rank, because it bypassed ranking" \
  "$(echo "$AUDIT4" | jnode "String(d.runs.flatMap(r=>r.attempts).find(a=>a.origin==='ADMIN_FORCE_ASSIGN').rank)")" "null"
has "and the reason attached" \
  "$(echo "$AUDIT4" | jnode "String(d.runs.flatMap(r=>r.attempts).find(a=>a.origin==='ADMIN_FORCE_ASSIGN').adminReason)")" "async framework"

# ── Requirement 7 ───────────────────────────────────────────────────────────

head1 "Requirement 7 — the 15-minute deadline is measured from submission"
DEADLINE_BEFORE=$(curl -s -b "$C_JAR" "$BASE/api/v1/requests/$REQ4_ID" | jget data.matchDeadlineAt)
curl -s -b "$A_JAR" -X POST "$BASE/api/v1/admin/requests/$REQ4_ID/dispatch" -H 'content-type: application/json' \
  -d "{\"mode\":\"assign\",\"expertProfileId\":\"$E2\",\"reason\":\"Trying the next candidate.\"}" >/dev/null
check "unchanged across a decline and a re-assignment" \
  "$(curl -s -b "$C_JAR" "$BASE/api/v1/requests/$REQ4_ID" | jget data.matchDeadlineAt)" "$DEADLINE_BEFORE"
check "and the window still counts down toward it" \
  "$(curl -s -b "$C_JAR" "$BASE/api/v1/requests/$REQ4_ID" | jnode "d.secondsUntilDeadline < 15*60")" "true"

# ── Requirement 8 ───────────────────────────────────────────────────────────

head1 "Requirement 8 — the offer window is durable"
OFF=$(curl -s -b "$E2_JAR" "$BASE/api/v1/expert/offer")
EXP_1=$(echo "$OFF" | jget data.offerExpiresAt)
sleep 2
EXP_2=$(curl -s -b "$E2_JAR" "$BASE/api/v1/expert/offer" | jget data.offerExpiresAt)
# Re-reading is what a browser refresh does. The deadline must not move.
check "a page refresh does not buy a fresh window" "$EXP_2" "$EXP_1"
check "and the countdown shrinks instead" \
  "$(curl -s -b "$E2_JAR" "$BASE/api/v1/expert/offer" | jnode "d.secondsRemaining < $(echo "$OFF" | jget data.secondsRemaining)")" "true"

WINDOW=$(echo "$OFF" | jnode "d.secondsRemaining")
if [ "$WINDOW" -gt 30 ] 2>/dev/null; then
  skip "timeout not exercised — the offer window is ${WINDOW}s"
  skip "re-run with OFFER_WINDOW_SECONDS=20 on the web app and worker"
  curl -s -b "$E2_JAR" -X POST "$BASE/api/v1/expert/offer" -H 'content-type: application/json' -d '{"decision":"decline"}' >/dev/null
else
  head1 "Requirement 10 — a timeout is not a decline"
  printf '  … saying nothing for %ss\n' "$((WINDOW + 6))"
  sleep "$((WINDOW + 6))"
  check "the offer is gone" "$(curl -s -b "$E2_JAR" "$BASE/api/v1/expert/offer" | jget data)" "null"
  AUDIT5=$(curl -s -b "$A_JAR" "$BASE/api/v1/admin/requests/$REQ4_ID/matching")
  has "recorded as TIMED_OUT, not DECLINED" \
    "$(echo "$AUDIT5" | jnode "JSON.stringify(d.runs.flatMap(r=>r.attempts).filter(a=>a.expertProfileId==='$E2').map(a=>a.status))")" \
    "TIMED_OUT"
  check "with no decline reason attached" \
    "$(echo "$AUDIT5" | jnode "String(d.runs.flatMap(r=>r.attempts).find(a=>a.status==='TIMED_OUT').declineReason)")" "null"
fi

# ── Requirement 11 ──────────────────────────────────────────────────────────

head1 "Requirement 11 — NO_EXPERT_FOUND beats the wrong expert"
cancel_live
C4_JAR=$(mktemp); new_customer "$C4_JAR" 4 >/dev/null
C_JAR=$C4_JAR
# Only the generalist is online, and they are BEGINNER at Apex. No relaxation
# level admits them, so an honest failure is the correct outcome.
curl -s -b "$E1_JAR" -X PUT "$BASE/api/v1/expert/availability" -H 'content-type: application/json' -d '{"available":false}' >/dev/null
curl -s -b "$E2_JAR" -X PUT "$BASE/api/v1/expert/availability" -H 'content-type: application/json' -d '{"available":false}' >/dev/null
curl -s -b "$E3_JAR" -X PUT "$BASE/api/v1/expert/availability" -H 'content-type: application/json' -d '{"available":true}' >/dev/null

REQ5=$(submit "Fifth Apex problem: we need someone to review a trigger framework refactor for governor-limit safety before release.")
REQ5_ID=$(echo "$REQ5" | jget data.request.id)
sleep 3

# Asserted as an invariant rather than as an expected state.
#
# The dev database accumulates approved, available experts from the Phase 2 and
# Phase 4 suites, and one of them may legitimately be a strong Apex match — so
# "the request must not reach OFFERED" would be testing the tidiness of the test
# database, not the floor. What must hold regardless of who else is online is
# that *nobody below the floor is ever offered it*.
BELOW_FLOOR_OFFERED=$(curl -s -b "$A_JAR" "$BASE/api/v1/admin/requests/$REQ5_ID/matching" \
  | jnode "String(d.runs.flatMap(r=>r.attempts).filter(a=>['OFFERED','ACCEPTED'].includes(a.status)).some(a=>(a.breakdown?.primaryBand ?? 9) < 1))")
check "nobody below the competence floor was offered the work" "$BELOW_FLOOR_OFFERED" "false"

check "the generalist specifically was not offered it" \
  "$(curl -s -b "$E3_JAR" "$BASE/api/v1/expert/offer" | jnode "String(Boolean(d && d.supportRequestId === '$REQ5_ID'))")" "false"
AUDIT6=$(curl -s -b "$A_JAR" "$BASE/api/v1/admin/requests/$REQ5_ID/matching")
has "and the audit says exactly why they were excluded" \
  "$(echo "$AUDIT6" | jnode "JSON.stringify(d.runs.flatMap(r=>r.attempts).filter(a=>a.expertProfileId==='$E3').flatMap(a=>a.exclusionReasons))")" \
  "PRIMARY_BELOW_FLOOR"
check "and the exclusion is marked permanent, not merely not-yet" \
  "$(echo "$AUDIT6" | jnode "String(d.runs.every(r=>r.filtersApplied.primaryFloor !== 'BEGINNER'))")" "true"

# ── Ownership ───────────────────────────────────────────────────────────────

head1 "Ownership"
check "an expert cannot answer an offer they do not hold" \
  "$(curl -s -b "$E1_JAR" -X POST "$BASE/api/v1/expert/offer" -H 'content-type: application/json' -d '{"decision":"accept"}' | jget error.code)" \
  "CONFLICT"
check "anonymous cannot read offers" \
  "$(curl -s "$BASE/api/v1/expert/offer" | jget error.code)" "UNAUTHENTICATED"
check "a customer has no offer surface" \
  "$(curl -s -b "$C_JAR" "$BASE/api/v1/expert/offer" | jget data)" "null"

cancel_live
printf '\n\033[1m%d passed, %d failed, %d skipped\033[0m\n' "$pass" "$fail" "$skipped"
rm -f "$C_JAR_MAIN" "$C_JAR" "$A_JAR" "$E1_JAR" "$E2_JAR" "$E3_JAR"
[ "$fail" -eq 0 ]
