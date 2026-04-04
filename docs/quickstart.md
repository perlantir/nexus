# Getting Started with DeciGraph

This guide walks you through deploying DeciGraph from zero to running.
Every command is copy-paste ready. You'll need:

- A Linux server (Ubuntu 22.04+ recommended) with Docker installed
- An API key from one of: OpenRouter, OpenAI, or Anthropic (optional — DeciGraph works without one)
- 10 minutes

---

## Step 1: Get an LLM API Key (Optional)

DeciGraph works without any API key. But if you want semantic search
(smarter context ranking) and auto-extraction (automatically pull
decisions from conversation transcripts), you need one key.

**We recommend OpenRouter** — one key gives you access to both
features through 200+ models.

1. Go to [openrouter.ai/keys](https://openrouter.ai/keys)
2. Create an account and generate an API key
3. Save the key somewhere — you'll need it in Step 3

If you prefer using OpenAI or Anthropic directly, that works too.
You can also skip this entirely and add a key later.

---

## Step 2: Clone the Repo

SSH into your server and run:

```bash
cd /opt
git clone https://github.com/perlantir/decigraph.git
cd decigraph
```

You should now be in `/opt/decigraph`. All remaining commands assume
you're in this directory.

---

## Step 3: Create Your Configuration File

Run this command. **Replace the two placeholder values** with your
own before hitting enter:

```bash
cat > .env << 'EOF'
DECIGRAPH_API_KEY=REPLACE_WITH_A_RANDOM_SECRET
OPENROUTER_API_KEY=REPLACE_WITH_YOUR_OPENROUTER_KEY
EOF
```

**What to replace:**

- `REPLACE_WITH_A_RANDOM_SECRET` — Make up a long random string.
  This is the password your agents will use to talk to DeciGraph.
  Example: `nx_a8f3k2m9x7p4q1w6`
- `REPLACE_WITH_YOUR_OPENROUTER_KEY` — Paste the OpenRouter API
  key from Step 1. It starts with `sk-or-`. If you don't have one,
  delete that entire line — DeciGraph will still work without it.

**Example with real-looking values:**

```bash
cat > .env << 'EOF'
DECIGRAPH_API_KEY=nx_a8f3k2m9x7p4q1w6r3t5
OPENROUTER_API_KEY=sk-or-v1-abc123def456ghi789
EOF
```

That's it. Two lines. DeciGraph handles everything else automatically.

---

## Step 4: Start DeciGraph

```bash
docker compose up -d
```

This downloads the required images and builds the containers.
**The first run takes 2-5 minutes** — it's compiling TypeScript
and downloading PostgreSQL. Subsequent starts take seconds.

You'll see progress bars for image downloads and build steps.
Wait until you see a message like:

```
 ✔ Container decigraph-db        Healthy
 ✔ Container decigraph-server    Started
 ✔ Container decigraph-dashboard Started
```

---

## Step 5: Verify It's Working

Run these three checks:

**Check 1: Is the server running?**

```bash
curl -s http://localhost:3100/api/health | jq .
```

You should see:

```json
{
  "status": "ok",
  "version": "0.1.0"
}
```

If you see nothing or an error, wait 30 seconds and try again — the server might still be starting.

**Check 2: Are the LLM providers connected?**

```bash
docker compose logs server | grep "\[decigraph\]"
```

You should see:

```
[decigraph] Database connected
[decigraph] Embeddings: openai/text-embedding-3-small via openrouter
[decigraph] Distillery: anthropic/claude-haiku-4-5-20251001 via openrouter
[decigraph] Server started
[decigraph] Listening on http://0.0.0.0:3100
```

If you see "Embeddings: disabled" or "Distillery: disabled", your OpenRouter key wasn't set correctly. Re-do Step 3 and then run:

```bash
docker compose up -d --force-recreate
```

**Check 3: Is the dashboard running?**

Open your browser and go to:

```
http://YOUR_SERVER_IP:3200
```

Replace `YOUR_SERVER_IP` with your server's IP address. You should see the DeciGraph dashboard.

---

## Step 6: Create Your First Project

Now set up a project and add some data. First, set two variables so you don't have to retype them:

```bash
export DECIGRAPH="http://localhost:3100"
export AUTH="Authorization: Bearer YOUR_DECIGRAPH_API_KEY"
```

Replace `YOUR_DECIGRAPH_API_KEY` with the value you set in Step 3 (the `DECIGRAPH_API_KEY` value, not the OpenRouter key).

**Create a project:**

```bash
curl -s -X POST $DECIGRAPH/api/projects \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"name": "my-project", "description": "My first DeciGraph project"}' | jq .
```

You'll get back a response with an `id` field. **Copy that ID** — you'll need it for the next commands. It looks like: `a1b2c3d4-e5f6-7890-abcd-ef1234567890`

Save it as a variable:

```bash
export PID="PASTE_YOUR_PROJECT_ID_HERE"
```

---

## Step 7: Register Your Agents

Register each agent that will use DeciGraph. Replace the names and roles with your actual agents:

```bash
curl -s -X POST $DECIGRAPH/api/projects/$PID/agents \
  -H "Content-Type: application/json" -H "$AUTH" \
  -d '{"name": "builder", "role": "builder"}'

curl -s -X POST $DECIGRAPH/api/projects/$PID/agents \
  -H "Content-Type: application/json" -H "$AUTH" \
  -d '{"name": "reviewer", "role": "reviewer"}'

curl -s -X POST $DECIGRAPH/api/projects/$PID/agents \
  -H "Content-Type: application/json" -H "$AUTH" \
  -d '{"name": "pm", "role": "governor"}'
```

Available roles: `builder`, `reviewer`, `governor`, `design`, `analytics`, `security`, `ops`, `launch`, `blockchain`, `challenge`, `qa`, `docs`

Each role has different relevance weights — a builder sees architecture decisions ranked highest while a marketer sees positioning decisions ranked highest.

Verify your agents were created:

```bash
curl -s $DECIGRAPH/api/projects/$PID/agents -H "$AUTH" | jq '.[].name'
```

---

## Step 8: Record Your First Decision

```bash
curl -s -X POST $DECIGRAPH/api/projects/$PID/decisions \
  -H "Content-Type: application/json" -H "$AUTH" \
  -d '{
    "title": "Use PostgreSQL for data storage",
    "description": "All persistent data stored in PostgreSQL 17 with pgvector for embeddings.",
    "reasoning": "Team familiarity, strong ecosystem, and native vector search support.",
    "made_by": "pm",
    "tags": ["database", "architecture"],
    "affects": ["builder", "reviewer"],
    "confidence": "high",
    "alternatives_considered": [
      {"option": "MongoDB", "rejected_reason": "No native vector search without Atlas Search"}
    ]
  }' | jq .
```

---

## Step 9: Test the Context Compiler

This is the core of DeciGraph. Compile context for two different agents and see how they get different views:

**What does the builder see?**

```bash
curl -s -X POST $DECIGRAPH/api/compile \
  -H "Content-Type: application/json" -H "$AUTH" \
  -d "{
    \"agent_name\": \"builder\",
    \"project_id\": \"$PID\",
    \"task_description\": \"Implement the data access layer\"
  }" | jq -r .formatted_markdown
```

**What does the PM see for the same project?**

```bash
curl -s -X POST $DECIGRAPH/api/compile \
  -H "Content-Type: application/json" -H "$AUTH" \
  -d "{
    \"agent_name\": \"pm\",
    \"project_id\": \"$PID\",
    \"task_description\": \"Plan the next sprint\"
  }" | jq -r .formatted_markdown
```

Compare the two outputs. The builder gets implementation-focused context. The PM gets project-planning context. Same decisions, different framing. That's DeciGraph working.

---

## Step 10: Open the Dashboard

Go to `http://YOUR_SERVER_IP:3200` in your browser. You should see:

- Your project in the sidebar
- The decision you created in the timeline
- The decision graph showing relationships
- Your agents listed

---

## What's Next

- **Add more decisions** as your team makes them
- **Connect your agents** using the SDK, CLI, or MCP server (see [MCP Setup](mcp-setup.md))
- **Test the distillery** — paste a conversation transcript and let DeciGraph extract decisions automatically
- **Set up change propagation** — when decisions change, affected agents get notified automatically

---

## Common Issues

**"Cannot connect to database"** The server started before PostgreSQL was ready. Run:

```bash
docker compose restart server
```

**"Embeddings: disabled" in logs** Your LLM API key isn't reaching the server. Check that `.env` has your key and run:

```bash
docker compose up -d --force-recreate
```

**Dashboard shows blank page** Make sure port 3200 is open in your firewall. Test with:

```bash
curl -s http://localhost:3200 | head -5
```

**"Connection refused" on curl commands** The server isn't running. Check status:

```bash
docker compose ps
docker compose logs server --tail 20
```

**Want to stop DeciGraph?**

```bash
docker compose down
```

**Want to start it again?**

```bash
cd /opt/decigraph && docker compose up -d
```

**Want to wipe everything and start fresh?**

```bash
docker compose down -v
docker compose up -d
```

This deletes all data. Use only if you want a clean slate.

---

## Updating DeciGraph

When new versions are released:

```bash
cd /opt/decigraph
git pull
docker compose up -d --build
```

This pulls the latest code, rebuilds the containers, and restarts. Your data is preserved in the PostgreSQL volume.
