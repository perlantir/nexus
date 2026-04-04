#!/usr/bin/env bash
set -e

# ============================================================
# DeciGraph Smoke Test
# Run after setup to verify everything works
# Usage: bash scripts/smoke-test.sh
# ============================================================

API_URL="${DECIGRAPH_API_URL:-http://localhost:3100}"
PASS=0
FAIL=0
WARN=0

pass() { echo "   ✅ $1"; PASS=$((PASS + 1)); }
fail() { echo "   ❌ $1"; FAIL=$((FAIL + 1)); }
warn() { echo "   ⚠️  $1"; WARN=$((WARN + 1)); }

echo ""
echo "  ╔══════════════════════════════════╗"
echo "  ║     DECIGRAPH SMOKE TEST             ║"
echo "  ╚══════════════════════════════════╝"
echo ""
echo "  API: $API_URL"
echo ""

# 1. Health check
echo "  1. API Health Check"
HEALTH=$(curl -sf "$API_URL/api/health" 2>/dev/null || echo "FAIL")
if echo "$HEALTH" | grep -q '"ok"'; then
  pass "API is healthy"
else
  fail "API health check failed. Is the server running on $API_URL?"
  echo ""
  echo "  Start the server with: pnpm --filter @decigraph/server dev"
  exit 1
fi

# 2. Create a project
echo ""
echo "  2. Create Project"
PROJECT=$(curl -sf -X POST "$API_URL/api/projects" \
  -H "Content-Type: application/json" \
  -d '{"name":"Smoke Test","description":"Automated verification"}' 2>/dev/null || echo "FAIL")
PROJECT_ID=$(echo "$PROJECT" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")
if [ -n "$PROJECT_ID" ] && [ "$PROJECT_ID" != "" ]; then
  pass "Project created: ${PROJECT_ID:0:8}..."
else
  fail "Failed to create project"
  echo "  Response: $PROJECT"
  exit 1
fi

# 3. Create an agent
echo ""
echo "  3. Create Agent"
AGENT=$(curl -sf -X POST "$API_URL/api/projects/$PROJECT_ID/agents" \
  -H "Content-Type: application/json" \
  -d '{"name":"smoke-builder","role":"builder"}' 2>/dev/null || echo "FAIL")
AGENT_ID=$(echo "$AGENT" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")
if [ -n "$AGENT_ID" ] && [ "$AGENT_ID" != "" ]; then
  pass "Agent created: ${AGENT_ID:0:8}..."
else
  fail "Failed to create agent"
  exit 1
fi

# 4. Record a decision
echo ""
echo "  4. Record Decision"
DECISION=$(curl -sf -X POST "$API_URL/api/projects/$PROJECT_ID/decisions" \
  -H "Content-Type: application/json" \
  -d '{
    "title":"Use TypeScript strict mode",
    "description":"All code written in TypeScript with strict mode for type safety.",
    "reasoning":"Catches bugs at compile time, improves refactoring confidence.",
    "made_by":"smoke-builder",
    "tags":["architecture","implementation"],
    "affects":["builder","reviewer"],
    "confidence":"high"
  }' 2>/dev/null || echo "FAIL")
DECISION_ID=$(echo "$DECISION" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")
if [ -n "$DECISION_ID" ] && [ "$DECISION_ID" != "" ]; then
  pass "Decision recorded: ${DECISION_ID:0:8}..."
else
  fail "Failed to record decision"
  exit 1
fi

# 5. List decisions
echo ""
echo "  5. List Decisions"
LIST=$(curl -sf "$API_URL/api/projects/$PROJECT_ID/decisions" 2>/dev/null || echo "FAIL")
if echo "$LIST" | grep -q '"title"'; then
  COUNT=$(echo "$LIST" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "?")
  pass "Listed $COUNT decision(s)"
else
  fail "Failed to list decisions"
fi

# 6. Compile context
echo ""
echo "  6. Compile Context"
CONTEXT=$(curl -sf -X POST "$API_URL/api/compile" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"agent_name\":\"smoke-builder\",\"task_description\":\"Implement user authentication\"}" 2>/dev/null || echo "FAIL")
if echo "$CONTEXT" | grep -q 'compiled_at\|formatted_markdown\|decisions'; then
  pass "Context compiled successfully"
else
  warn "Context compilation returned unexpected result (embedding API key may be needed)"
fi

# 7. Project stats
echo ""
echo "  7. Project Stats"
STATS=$(curl -sf "$API_URL/api/projects/$PROJECT_ID/stats" 2>/dev/null || echo "FAIL")
if echo "$STATS" | grep -q 'total_decisions'; then
  pass "Project stats available"
else
  fail "Failed to get project stats"
fi

# 8. Rate limit headers
echo ""
echo "  8. Rate Limiting"
HEADERS=$(curl -sI "$API_URL/api/health" 2>/dev/null || echo "")
if echo "$HEADERS" | grep -qi "x-ratelimit\|x-response-time"; then
  pass "Rate limit headers present"
else
  warn "Rate limit headers not detected (may be disabled in dev mode)"
fi

# Summary
echo ""
echo "  ─────────────────────────────────"
echo "  Results: $PASS passed, $FAIL failed, $WARN warnings"
echo "  ─────────────────────────────────"
echo ""

if [ $FAIL -gt 0 ]; then
  echo "  Some tests failed. Check the output above for details."
  exit 1
else
  echo "  DeciGraph is ready. Next steps:"
  echo ""
  echo "    Set OPENAI_API_KEY in .env      → enables semantic search + embeddings"
  echo "    Set ANTHROPIC_API_KEY in .env    → enables auto-extraction from conversations"
  echo "    Open http://localhost:3200       → dashboard (if running docker compose)"
  echo "    Run: pnpm db:seed               → load demo data to explore"
  echo "    Read: docs/quickstart.md         → full getting started guide"
  echo ""
fi
