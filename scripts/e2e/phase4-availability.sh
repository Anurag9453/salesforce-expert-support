#!/usr/bin/env bash
# Phase 4 exit criterion, over real HTTP.
#
# Only an approved expert can go available; approval alone is not eligibility;
# and the stale-presence sweep is sticky — a heartbeat after a sweep does not
# bring anyone back.
#
# The sweep normally runs on a 180-second window, which is far too long for a
# test. Run the web app and worker with a short window and this script exercises
# the real timing:
#
#   HEARTBEAT_STALE_AFTER_SECONDS=10 HEARTBEAT_INTERVAL_SECONDS=5 pnpm dev
#   pnpm e2e:phase4
#
# With the default 180s window the sweep section is skipped rather than failed —
# it would need a three-minute pause to be honest about.
set -uo pipefail

REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
BASE="${BASE:-http://localhost:3000}"
E_JAR=$(mktemp); A_JAR=$(mktemp); D_JAR=$(mktemp)
STAMP=$(date +%s)
EXPERT="avail-${STAMP}@example.com"
ADMIN="availadmin-${STAMP}@example.com"
DRAFTER="availdraft-${STAMP}@example.com"
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

signup() { curl -s -c "$2" -X POST "$BASE/api/auth/sign-up/email" -H 'content-type: application/json' \
  -d "{\"email\":\"$1\",\"password\":\"$PW\",\"name\":\"$3\"}"; }

avail()  { curl -s -b "$1" "$BASE/api/v1/expert/availability"; }
toggle() { curl -s -b "$1" -X PUT "$BASE/api/v1/expert/availability" -H 'content-type: application/json' -d "{\"available\":$2}"; }
beat()   { curl -s -b "$1" -X POST "$BASE/api/v1/expert/heartbeat"; }

# ── Setup: one approved expert, one admin, one DRAFT applicant ────────────────

head1 "Setup"
signup "$EXPERT" "$E_JAR" "Expert" >/dev/null
signup "$ADMIN" "$A_JAR" "Admin" >/dev/null
signup "$DRAFTER" "$D_JAR" "Drafter" >/dev/null
(cd "$REPO/packages/db" && pnpm exec dotenv -e ../../.env -- node scripts/grant-role.mjs "$ADMIN" ADMIN) >/dev/null 2>&1
ok "three accounts, one of them an admin"

APP=$(curl -s -b "$E_JAR" -X POST "$BASE/api/v1/expert-application")
APP_ID=$(echo "$APP" | jget data.id)
curl -s -b "$E_JAR" -X PATCH "$BASE/api/v1/expert-application" -H 'content-type: application/json' \
  -d '{"country":"IN","timezone":"Asia/Kolkata","yearsExperience":9,
       "professionalSummary":"Apex, integration and CPQ work across a dozen orgs, mostly untangling governor limits and async jobs that were written in a hurry.",
       "languages":["en"],"certifications":["Platform Developer II"],
       "acceptTerms":true,"acceptConfidentiality":true}' >/dev/null
ok "expert application completed"

DRAFT_APP=$(curl -s -b "$D_JAR" -X POST "$BASE/api/v1/expert-application")
DRAFT_ID=$(echo "$DRAFT_APP" | jget data.id)
check "second applicant is DRAFT" "$(echo "$DRAFT_APP" | jget data.status)" "DRAFT"

# ── Requirement 3 ────────────────────────────────────────────────────────────

head1 "Requirement 3 — only approved experts may go AVAILABLE"

DRAFT_ON=$(toggle "$D_JAR" true)
check "DRAFT refused" "$(echo "$DRAFT_ON" | jget error.code)" "FORBIDDEN"
check "DRAFT still offline after the attempt" "$(avail "$D_JAR" | jget data.availabilityStatus)" "OFFLINE"

SUB_ON=$(toggle "$E_JAR" true)
check "pre-submission expert refused" "$(echo "$SUB_ON" | jget error.code)" "FORBIDDEN"

curl -s -b "$E_JAR" -X POST "$BASE/api/v1/expert-application/submit" >/dev/null
check "SUBMITTED refused" "$(toggle "$E_JAR" true | jget error.code)" "FORBIDDEN"

curl -s -b "$A_JAR" -X POST "$BASE/api/v1/admin/experts/$APP_ID/decision" \
  -H 'content-type: application/json' -d '{"decision":"claim"}' >/dev/null
check "UNDER_REVIEW refused" "$(toggle "$E_JAR" true | jget error.code)" "FORBIDDEN"

ANON=$(curl -s -X PUT "$BASE/api/v1/expert/availability" -H 'content-type: application/json' -d '{"available":true}')
check "anonymous refused" "$(echo "$ANON" | jget error.code)" "UNAUTHENTICATED"

curl -s -b "$A_JAR" -X POST "$BASE/api/v1/admin/experts/$APP_ID/decision" \
  -H 'content-type: application/json' -d '{"decision":"approve","notes":"Deep Apex and integration experience, checked against two references."}' >/dev/null
ok "approved by the admin"

# ── Requirement 4 ────────────────────────────────────────────────────────────

head1 "Requirement 4 — approval alone is not eligibility"

A=$(avail "$E_JAR")
check "approved but offline" "$(echo "$A" | jget data.availabilityStatus)" "OFFLINE"
check "not eligible" "$(echo "$A" | jget data.eligibility.eligible)" "false"
has "and says why" "$(echo "$A" | jget data.eligibility.reasons)" "NOT_AVAILABLE"
# Requirement 6 depends on this: the server supplies the sentence, so every
# client says the same thing.
has "with human-readable copy" "$(echo "$A" | jget data.eligibility.messages)" "set to offline"

ON=$(toggle "$E_JAR" true)
check "now available" "$(echo "$ON" | jget data.availabilityStatus)" "AVAILABLE"
check "and eligible" "$(echo "$ON" | jget data.eligibility.eligible)" "true"
check "no outstanding reasons" "$(echo "$ON" | jget data.eligibility.reasons)" "[]"
# The toggle seeds presence so there is no dead window before the first ping.
check "presence starts fresh, not null" "$(echo "$ON" | jget data.secondsSinceHeartbeat)" "0"
check "client is told the ping interval" "$(echo "$ON" | jget data.heartbeatIntervalSeconds)" \
  "$(echo "$ON" | jget data.heartbeatIntervalSeconds)"

check "toggling on twice is idempotent" "$(toggle "$E_JAR" true | jget data.availabilityStatus)" "AVAILABLE"

B=$(beat "$E_JAR")
check "heartbeat keeps it available" "$(echo "$B" | jget data.availabilityStatus)" "AVAILABLE"
check "heartbeat keeps it eligible" "$(echo "$B" | jget data.eligibility.eligible)" "true"

# ── Requirement 8 ────────────────────────────────────────────────────────────

head1 "Requirement 8 — profile edits cannot touch administrative fields"

EDIT=$(curl -s -b "$E_JAR" -X PATCH "$BASE/api/v1/expert/profile" -H 'content-type: application/json' \
  -d '{"employmentStatus":"Independent consultant"}')
check "an approved expert can still edit their profile" "$(echo "$EDIT" | jget data.employmentStatus)" "Independent consultant"
check "and stays APPROVED — no re-review" "$(echo "$EDIT" | jget data.status)" "APPROVED"

HIJACK=$(curl -s -b "$E_JAR" -X PATCH "$BASE/api/v1/expert/profile" -H 'content-type: application/json' \
  -d '{"country":"IN","status":"APPROVED","reviewNotes":"I approved myself","availabilityStatus":"AVAILABLE","sessionsCompleted":900,"payoutsEnabled":true}')
# Refused, not silently stripped: a dropped key looks to the caller exactly like
# a successful escalation.
check "administrative fields rejected outright" "$(echo "$HIJACK" | jget error.code)" "VALIDATION_ERROR"
AFTER=$(curl -s -b "$E_JAR" "$BASE/api/v1/expert/profile")
check "review notes unchanged" "$(echo "$AFTER" | jget data.reviewNotes)" "Deep Apex and integration experience, checked against two references."

# ── Requirements 1, 2 and 7 ──────────────────────────────────────────────────

head1 "Requirements 1 & 2 — skills are self-declared, verification is not"

SKILL=$(curl -s -b "$E_JAR" -X PUT "$BASE/api/v1/expert/skills" -H 'content-type: application/json' \
  -d '{"skillSlug":"apex","proficiencyLevel":"ADVANCED","yearsExperience":6}')
check "declared apex" "$(echo "$SKILL" | jget data.skillSlug)" "apex"
check "with a proficiency" "$(echo "$SKILL" | jget data.proficiencyLevel)" "ADVANCED"
check "and years for that specific skill" "$(echo "$SKILL" | jget data.yearsExperience)" "6"
check "not verified" "$(echo "$SKILL" | jget data.verified)" "false"

SELF_VERIFY=$(curl -s -b "$E_JAR" -X PUT "$BASE/api/v1/expert/skills" -H 'content-type: application/json' \
  -d '{"skillSlug":"apex","proficiencyLevel":"EXPERT","yearsExperience":6,"verified":true,"verifiedAt":"2020-01-01T00:00:00Z"}')
# The request shape has no `verified` field, so the claim is dropped and the
# declaration itself still succeeds. What must never happen is it being honoured.
check "an expert cannot verify their own skill" "$(echo "$SELF_VERIFY" | jget data.verified)" "false"

NO_ADMIN=$(curl -s -b "$E_JAR" -X POST "$BASE/api/v1/admin/experts/$APP_ID/skills" -H 'content-type: application/json' \
  -d '{"skillSlug":"apex","verified":true,"notes":"me again"}')
check "and cannot reach the admin route either" "$(echo "$NO_ADMIN" | jget error.code)" "FORBIDDEN"

NO_NOTES=$(curl -s -b "$A_JAR" -X POST "$BASE/api/v1/admin/experts/$APP_ID/skills" -H 'content-type: application/json' \
  -d '{"skillSlug":"apex","verified":true,"notes":""}')
check "verification with no reason refused" "$(echo "$NO_NOTES" | jget error.code)" "VALIDATION_ERROR"

VERIFIED=$(curl -s -b "$A_JAR" -X POST "$BASE/api/v1/admin/experts/$APP_ID/skills" -H 'content-type: application/json' \
  -d '{"skillSlug":"apex","verified":true,"notes":"Walked through a bulkification fix on a live sandbox."}')
check "admin can verify" "$(echo "$VERIFIED" | jget data.verified)" "true"

REDECLARE=$(curl -s -b "$E_JAR" -X PUT "$BASE/api/v1/expert/skills" -H 'content-type: application/json' \
  -d '{"skillSlug":"apex","proficiencyLevel":"EXPERT","yearsExperience":9}')
# The claim that was vouched for has changed, so the vouch no longer applies.
# Otherwise re-declaring is a way to launder an unverified claim into a verified one.
check "re-declaring clears the verification" "$(echo "$REDECLARE" | jget data.verified)" "false"

head1 "Requirement 7 — proficiency is bounded and years are per-skill"
check "unknown proficiency refused" \
  "$(curl -s -b "$E_JAR" -X PUT "$BASE/api/v1/expert/skills" -H 'content-type: application/json' -d '{"skillSlug":"apex","proficiencyLevel":"GURU","yearsExperience":3}' | jget error.code)" \
  "VALIDATION_ERROR"
check "absurd year counts refused" \
  "$(curl -s -b "$E_JAR" -X PUT "$BASE/api/v1/expert/skills" -H 'content-type: application/json' -d '{"skillSlug":"apex","proficiencyLevel":"EXPERT","yearsExperience":99}' | jget error.code)" \
  "VALIDATION_ERROR"
check "zero years accepted as an honest answer" \
  "$(curl -s -b "$E_JAR" -X PUT "$BASE/api/v1/expert/skills" -H 'content-type: application/json' -d '{"skillSlug":"flow","proficiencyLevel":"INTERMEDIATE","yearsExperience":0}' | jget data.yearsExperience)" \
  "0"
check "unknown skill refused" \
  "$(curl -s -b "$E_JAR" -X PUT "$BASE/api/v1/expert/skills" -H 'content-type: application/json' -d '{"skillSlug":"blockchain-on-salesforce","proficiencyLevel":"EXPERT","yearsExperience":10}' | jget error.code)" \
  "NOT_FOUND"

# ── Requirement 9 ────────────────────────────────────────────────────────────

head1 "Requirement 9 — one call serves a mobile client"
WS=$(curl -s -b "$E_JAR" "$BASE/api/v1/expert/workspace")
check "workspace returns the status" "$(echo "$WS" | jget data.expertStatus)" "APPROVED"
check "the eligibility verdict" "$(echo "$WS" | jget data.availability.eligibility.eligible)" "true"
check "and whether the toggle is even permitted" "$(echo "$WS" | jget data.canGoAvailable)" "true"
check "with the skill list attached" "$(echo "$WS" | jget data.skills | grep -c apex || true)" "1"

DWS=$(curl -s -b "$D_JAR" "$BASE/api/v1/expert/workspace")
check "a DRAFT expert is told the toggle is closed to them" "$(echo "$DWS" | jget data.canGoAvailable)" "false"

# ── Requirement 5 — the sticky sweep ─────────────────────────────────────────

head1 "Requirement 5 — the sweep is sticky"

STALE_AFTER=$(avail "$E_JAR" | jget data.heartbeatStaleAfterSeconds)
if [ "$STALE_AFTER" -gt 60 ] 2>/dev/null; then
  skip "sweep not exercised — HEARTBEAT_STALE_AFTER_SECONDS is ${STALE_AFTER}s"
  skip "re-run with HEARTBEAT_STALE_AFTER_SECONDS=10 on both web and worker"
else
  toggle "$E_JAR" true >/dev/null
  check "online before the wait" "$(avail "$E_JAR" | jget data.availabilityStatus)" "AVAILABLE"

  # Stop pinging. Wait out the window, plus the worker's 30s sweep interval.
  WAIT=$((STALE_AFTER + 35))
  printf '  … not pinging for %ss (window %ss + sweep interval)\n' "$WAIT" "$STALE_AFTER"

  # Before the sweep lands, presence is already stale — the expert is
  # unmatchable by eligibility even while the status still reads AVAILABLE.
  sleep "$((STALE_AFTER + 2))"
  MID=$(avail "$E_JAR")
  has "stale presence makes them ineligible before the sweep runs" \
    "$(echo "$MID" | jget data.eligibility.reasons)" "PRESENCE_STALE"

  sleep 33
  SWEPT=$(avail "$E_JAR")
  check "swept OFFLINE by the worker" "$(echo "$SWEPT" | jget data.availabilityStatus)" "OFFLINE"

  # The whole point. A ping arriving after the sweep records presence and
  # nothing else.
  BACK=$(beat "$E_JAR")
  check "a heartbeat does NOT restore availability" "$(echo "$BACK" | jget data.availabilityStatus)" "OFFLINE"
  check "still ineligible" "$(echo "$BACK" | jget data.eligibility.eligible)" "false"
  beat "$E_JAR" >/dev/null; beat "$E_JAR" >/dev/null
  check "nor do several" "$(avail "$E_JAR" | jget data.availabilityStatus)" "OFFLINE"

  RESTORED=$(toggle "$E_JAR" true)
  check "only an explicit toggle brings them back" "$(echo "$RESTORED" | jget data.availabilityStatus)" "AVAILABLE"

  HIST=$(curl -s -b "$E_JAR" "$BASE/api/v1/expert/availability/history")
  has "history records the sweep and its cause" "$HIST" "HEARTBEAT_TIMEOUT"
  # A system action, so no user is blamed for it.
  check "the sweep is attributed to no user" \
    "$(echo "$HIST" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=JSON.parse(s).data.find(x=>x.source==="HEARTBEAT_TIMEOUT");console.log(String(e.changedByUserId))})')" \
    "null"
fi

# ── Requirement 3, the hard case ─────────────────────────────────────────────

head1 "Requirement 3 — suspension while online"

toggle "$E_JAR" true >/dev/null
curl -s -b "$A_JAR" -X POST "$BASE/api/v1/admin/experts/$APP_ID/decision" \
  -H 'content-type: application/json' -d '{"decision":"suspend","notes":"Investigating a complaint."}' >/dev/null

SUSPENDED=$(avail "$E_JAR")
# Suspension does not itself write the availability row, so the status can still
# read AVAILABLE for up to one sweep interval. That is fine *because eligibility
# is a conjunction*: NOT_APPROVED lands immediately, so nothing can be dispatched
# to them in the meantime. The status catches up; the guarantee never lapses.
check "no longer eligible the instant they are suspended" "$(echo "$SUSPENDED" | jget data.eligibility.eligible)" "false"
has "and the reason is their status" "$(echo "$SUSPENDED" | jget data.eligibility.reasons)" "NOT_APPROVED"
check "can still take themselves offline" "$(toggle "$E_JAR" false | jget data.availabilityStatus)" "OFFLINE"
check "but cannot go available again" "$(toggle "$E_JAR" true | jget error.code)" "FORBIDDEN"

curl -s -b "$A_JAR" -X POST "$BASE/api/v1/admin/experts/$APP_ID/decision" \
  -H 'content-type: application/json' -d '{"decision":"reinstate","notes":"Complaint not substantiated."}' >/dev/null
check "reinstatement restores the toggle" "$(toggle "$E_JAR" true | jget data.availabilityStatus)" "AVAILABLE"

# ── Ownership ────────────────────────────────────────────────────────────────

head1 "Ownership"
OTHER_HIST=$(curl -s -b "$D_JAR" "$BASE/api/v1/expert/availability/history")
hasnt "history is scoped to the caller" "$OTHER_HIST" "HEARTBEAT_TIMEOUT"
DEL=$(curl -s -b "$D_JAR" -X DELETE "$BASE/api/v1/expert/skills/apex")
check "deleting a skill only ever affects your own" "$(echo "$DEL" | jget data.removed)" "apex"
check "the approved expert still has apex" \
  "$(curl -s -b "$E_JAR" "$BASE/api/v1/expert/skills" | grep -c '"skillSlug":"apex"' || true)" "1"

printf '\n\033[1m%d passed, %d failed, %d skipped\033[0m\n' "$pass" "$fail" "$skipped"
rm -f "$E_JAR" "$A_JAR" "$D_JAR"
[ "$fail" -eq 0 ]
