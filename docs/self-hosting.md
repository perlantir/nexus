# Self-Hosting Nexus

This guide covers everything you need to run Nexus in production: Docker Compose deployment, manual installation, reverse proxy configuration, TLS/SSL, database backups, and monitoring.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Docker Compose Deployment](#docker-compose-deployment)
- [Manual Installation](#manual-installation)
- [Environment Configuration](#environment-configuration)
- [Nginx Reverse Proxy](#nginx-reverse-proxy)
- [TLS / SSL with Let's Encrypt](#tls--ssl-with-lets-encrypt)
- [Database Management](#database-management)
- [Backups](#backups)
- [Monitoring & Observability](#monitoring--observability)
- [Scaling Considerations](#scaling-considerations)
- [Security Hardening](#security-hardening)
- [Upgrading Nexus](#upgrading-nexus)

---

## Architecture Overview

A production Nexus deployment consists of three services:

```
Internet
   │
   ▼
nginx (80/443)
   │
   ├──── /api/*    ──▶  nexus-server   (port 3100)
   │                        │
   └──── /*         ──▶  nexus-dashboard (port 3200)
                            │
                     PostgreSQL 17 + pgvector
                          (port 5432)
```

All three services can run on a single VM for small deployments. For larger teams, extract PostgreSQL to a managed service (RDS, Supabase, Neon) and scale the server horizontally.

---

## Docker Compose Deployment

This is the recommended production deployment method.

### Step 1: Clone and Configure

```bash
git clone https://github.com/perlantir/nexus.git
cd nexus

# Copy the example environment file
cp .env.example .env
```

Edit `.env` with production values (see [Environment Configuration](#environment-configuration)).

### Step 2: Build Images

```bash
docker compose build
```

Or pull pre-built images if your CI pushes them to a registry:

```bash
docker compose pull
```

### Step 3: Start Services

```bash
# Start in detached mode
docker compose up -d

# Check all services are healthy
docker compose ps
```

Expected output:

```
NAME                STATUS          PORTS
nexus-postgres-1    Up (healthy)    5432/tcp
nexus-server-1      Up              0.0.0.0:3100->3100/tcp
nexus-dashboard-1   Up              0.0.0.0:3200->3200/tcp
```

### Step 4: Run Migrations

```bash
docker compose exec server pnpm db:migrate
```

Or run migrations directly against the database:

```bash
docker compose exec postgres psql -U nexus -d nexus \
  -f /migrations/001_initial_schema.sql \
  -f /migrations/002_audit_log.sql \
  -f /migrations/003_relevance_feedback.sql
```

### Step 5: Create Your First Project

```bash
curl -X POST http://localhost:3100/api/projects \
  -H "Content-Type: application/json" \
  -d '{"name": "My Project", "description": "Production project"}'
```

### Docker Compose File Reference

The included `docker-compose.yml` defines these services:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: nexus
      POSTGRES_PASSWORD: nexus_dev   # Override in production!
      POSTGRES_DB: nexus
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U nexus"]
      interval: 5s
      timeout: 5s
      retries: 5

  server:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3100:3100"
    environment:
      DATABASE_URL: postgresql://nexus:nexus_dev@postgres:5432/nexus
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
    depends_on:
      postgres:
        condition: service_healthy

  dashboard:
    build:
      context: .
      dockerfile: Dockerfile.dashboard
    ports:
      - "3200:3200"
    environment:
      VITE_API_URL: ${VITE_API_URL:-http://localhost:3100}
    depends_on:
      - server

volumes:
  postgres_data:
```

### Production Docker Compose Override

Create a `docker-compose.prod.yml` override for production-specific settings:

```yaml
services:
  postgres:
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}  # Strong random password
    restart: always

  server:
    restart: always
    environment:
      NODE_ENV: production
      NEXUS_API_KEY: ${NEXUS_API_KEY}
    # Remove public port binding — nginx handles it
    ports: []

  dashboard:
    restart: always
    ports: []
```

Run with both files:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

---

## Manual Installation

For environments where Docker is not available.

### Prerequisites

| Dependency | Version | Notes |
|-----------|---------|-------|
| Node.js | ≥ 20 | LTS recommended |
| pnpm | ≥ 8 | `npm install -g pnpm` |
| PostgreSQL | 17 | With pgvector extension |
| pgvector | ≥ 0.7 | Must be installed in PostgreSQL |

### Installing pgvector

**Ubuntu / Debian:**

```bash
sudo apt install postgresql-17-pgvector
```

**macOS (Homebrew):**

```bash
brew install pgvector
```

**From source:**

```bash
git clone https://github.com/pgvector/pgvector.git
cd pgvector
make
make install  # requires postgresql-server-dev-17
```

Enable the extension in your database:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### Database Setup

```bash
# Create user and database
sudo -u postgres psql <<EOF
CREATE USER nexus WITH PASSWORD 'your_strong_password';
CREATE DATABASE nexus OWNER nexus;
\c nexus
CREATE EXTENSION IF NOT EXISTS vector;
GRANT ALL PRIVILEGES ON DATABASE nexus TO nexus;
EOF
```

### Install Dependencies and Build

```bash
git clone https://github.com/perlantir/nexus.git
cd nexus

# Install all workspace dependencies
pnpm install

# Build all packages
pnpm build
```

### Run Migrations

```bash
# Using the Nexus CLI
NEXUS_API_URL=http://localhost:3100 pnpm --filter @nexus/server db:migrate

# Or apply SQL files directly
psql -U nexus -d nexus -f supabase/migrations/001_initial_schema.sql
psql -U nexus -d nexus -f supabase/migrations/002_audit_log.sql
psql -U nexus -d nexus -f supabase/migrations/003_relevance_feedback.sql
```

### Start the Server

```bash
# Development
pnpm dev

# Production (after build)
NODE_ENV=production node packages/server/dist/index.js
```

### Systemd Service

Create `/etc/systemd/system/nexus-server.service`:

```ini
[Unit]
Description=Nexus Decision Memory Server
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=nexus
WorkingDirectory=/opt/nexus
EnvironmentFile=/opt/nexus/.env
ExecStart=/usr/bin/node packages/server/dist/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=nexus-server

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/nexus

[Install]
WantedBy=multi-user.target
```

Create `/etc/systemd/system/nexus-dashboard.service`:

```ini
[Unit]
Description=Nexus Dashboard
After=nexus-server.service
Requires=nexus-server.service

[Service]
Type=simple
User=nexus
WorkingDirectory=/opt/nexus
EnvironmentFile=/opt/nexus/.env
ExecStart=/usr/bin/node packages/dashboard/dist/server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable nexus-server nexus-dashboard
sudo systemctl start nexus-server nexus-dashboard
sudo systemctl status nexus-server
```

---

## Environment Configuration

Copy `.env.example` to `.env` and configure the following variables:

### Required Variables

```bash
# Database
DATABASE_URL=postgresql://nexus:your_password@localhost:5432/nexus
DATABASE_POOL_MIN=2
DATABASE_POOL_MAX=10

# AI Providers
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=sk-...          # Required for embeddings

DISTILLERY_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...   # Required for LLM extraction

# Server
PORT=3100
HOST=0.0.0.0
NODE_ENV=production

# Security
NEXUS_API_KEY=<random 64-char hex string>
```

Generate a strong `NEXUS_API_KEY`:

```bash
openssl rand -hex 64
```

### Optional Variables

```bash
# MCP transport (stdio or sse)
MCP_TRANSPORT=stdio

# Dashboard API URL (what the dashboard browser talks to)
VITE_API_URL=https://api.yourdomain.com

# Logging
LOG_LEVEL=info    # debug | info | warn | error
```

### Alternative Embedding Providers

If you prefer not to use OpenAI for embeddings:

```bash
EMBEDDING_PROVIDER=local
LOCAL_EMBEDDING_URL=http://localhost:11434/api/embeddings
LOCAL_EMBEDDING_MODEL=nomic-embed-text
```

### Alternative Distillery Providers

```bash
DISTILLERY_PROVIDER=openai
OPENAI_DISTILLERY_MODEL=gpt-4o-mini
```

---

## Nginx Reverse Proxy

### Installation

```bash
sudo apt install nginx
```

### Configuration

Create `/etc/nginx/sites-available/nexus`:

```nginx
upstream nexus_api {
    server 127.0.0.1:3100;
    keepalive 32;
}

upstream nexus_dashboard {
    server 127.0.0.1:3200;
    keepalive 16;
}

server {
    listen 80;
    server_name nexus.yourdomain.com;

    # Redirect all HTTP to HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name nexus.yourdomain.com;

    # SSL certificates (configured by Certbot)
    ssl_certificate /etc/letsencrypt/live/nexus.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/nexus.yourdomain.com/privkey.pem;
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:50m;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    # Security headers
    add_header Strict-Transport-Security "max-age=63072000" always;
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    add_header Referrer-Policy no-referrer-when-downgrade;

    # API routes
    location /api/ {
        proxy_pass http://nexus_api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";

        # Timeouts — context compilation can take a few seconds
        proxy_connect_timeout 10s;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;

        # Request size limit for distillery payloads
        client_max_body_size 10m;
    }

    # Health endpoint (bypass auth for load balancers)
    location /health {
        proxy_pass http://nexus_api;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        access_log off;
    }

    # Dashboard
    location / {
        proxy_pass http://nexus_dashboard;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Enable and test:

```bash
sudo ln -s /etc/nginx/sites-available/nexus /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### Separate API and Dashboard Domains

If you want separate subdomains for the API and dashboard:

```nginx
# api.yourdomain.com → port 3100
server {
    listen 443 ssl http2;
    server_name api.yourdomain.com;
    # ... (same SSL config)

    location / {
        proxy_pass http://nexus_api;
        # ... (same proxy settings)
    }
}

# app.yourdomain.com → port 3200
server {
    listen 443 ssl http2;
    server_name app.yourdomain.com;
    # ... (same SSL config)

    location / {
        proxy_pass http://nexus_dashboard;
        # ... (same proxy settings)
    }
}
```

Set `VITE_API_URL=https://api.yourdomain.com` so the dashboard browser knows where to call the API.

---

## TLS / SSL with Let's Encrypt

### Install Certbot

```bash
sudo apt install certbot python3-certbot-nginx
```

### Obtain Certificate

```bash
sudo certbot --nginx -d nexus.yourdomain.com
```

Certbot automatically modifies your nginx config to add the SSL certificate paths and enables auto-renewal.

### Manual Certificate Renewal

Certificates expire after 90 days. Certbot installs a systemd timer that auto-renews. Verify it:

```bash
sudo systemctl status certbot.timer
sudo certbot renew --dry-run
```

### Wildcard Certificate (optional)

For `*.yourdomain.com`:

```bash
sudo certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials ~/.secrets/cloudflare.ini \
  -d "*.yourdomain.com" \
  -d "yourdomain.com"
```

---

## Database Management

### Connecting to the Database

**Docker Compose:**

```bash
docker compose exec postgres psql -U nexus -d nexus
```

**Manual install:**

```bash
psql -U nexus -h localhost -d nexus
```

### Useful Queries

Check decision count and embedding coverage:

```sql
SELECT
  COUNT(*) AS total_decisions,
  COUNT(embedding) AS with_embeddings,
  COUNT(*) - COUNT(embedding) AS missing_embeddings,
  status,
  COUNT(*) as count_by_status
FROM decisions
GROUP BY status;
```

Check HNSW index size:

```sql
SELECT
  tablename,
  indexname,
  pg_size_pretty(pg_relation_size(indexname::regclass)) AS index_size
FROM pg_indexes
WHERE tablename IN ('decisions', 'artifacts')
AND indexname LIKE '%embedding%';
```

Find decisions without embeddings (need re-indexing):

```sql
SELECT id, title, created_at
FROM decisions
WHERE embedding IS NULL
ORDER BY created_at DESC;
```

### Connection Pool Tuning

For high-concurrency deployments, tune the pool:

```bash
DATABASE_POOL_MIN=5
DATABASE_POOL_MAX=25
```

PostgreSQL `max_connections` must be higher than your pool maximum:

```sql
SHOW max_connections;
-- If too low, add to postgresql.conf:
-- max_connections = 100
```

---

## Backups

### Automated pg_dump Backup

Create `/opt/nexus/scripts/backup.sh`:

```bash
#!/bin/bash
set -euo pipefail

BACKUP_DIR="/var/backups/nexus"
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/nexus_${DATE}.dump"

mkdir -p "$BACKUP_DIR"

# Custom-format dump (compressed, supports parallel restore)
pg_dump \
  --format=custom \
  --compress=9 \
  --no-acl \
  --no-owner \
  --file="$BACKUP_FILE" \
  "postgresql://nexus:${POSTGRES_PASSWORD}@localhost:5432/nexus"

echo "Backup written to $BACKUP_FILE"

# Delete backups older than 30 days
find "$BACKUP_DIR" -name "nexus_*.dump" -mtime +30 -delete

echo "Backup complete: $(ls -lh $BACKUP_FILE | awk '{print $5}')"
```

Make executable and schedule:

```bash
chmod +x /opt/nexus/scripts/backup.sh

# Run daily at 2am
echo "0 2 * * * nexus /opt/nexus/scripts/backup.sh >> /var/log/nexus-backup.log 2>&1" \
  | sudo tee -a /etc/cron.d/nexus-backup
```

### Restoring from Backup

```bash
# Stop the server
sudo systemctl stop nexus-server

# Drop and recreate the database
sudo -u postgres psql -c "DROP DATABASE nexus;"
sudo -u postgres psql -c "CREATE DATABASE nexus OWNER nexus;"
sudo -u postgres psql -d nexus -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Restore
pg_restore \
  --format=custom \
  --no-acl \
  --no-owner \
  --dbname="postgresql://nexus:your_password@localhost:5432/nexus" \
  /var/backups/nexus/nexus_20260101_020000.dump

# Restart the server
sudo systemctl start nexus-server
```

### Docker Compose Backup

```bash
# Backup
docker compose exec postgres pg_dump \
  -U nexus -Fc nexus > nexus_backup_$(date +%Y%m%d).dump

# Restore
docker compose exec -T postgres pg_restore \
  -U nexus -d nexus < nexus_backup_20260101.dump
```

### Continuous Archiving with WAL-G (Advanced)

For near-zero RPO, configure WAL-G with S3:

```bash
# Install WAL-G
wget https://github.com/wal-g/wal-g/releases/latest/download/wal-g-pg-ubuntu-22.04-amd64
chmod +x wal-g-pg-ubuntu-22.04-amd64
sudo mv wal-g-pg-ubuntu-22.04-amd64 /usr/local/bin/wal-g
```

Add to `postgresql.conf`:

```
archive_mode = on
archive_command = 'wal-g wal-push %p'
archive_timeout = 60
```

Schedule base backups:

```bash
# Weekly full backup
0 1 * * 0 postgres wal-g backup-push $PGDATA
```

---

## Monitoring & Observability

### Health Check Endpoint

Nexus exposes a health endpoint at `/health`:

```bash
curl http://localhost:3100/health
```

```json
{
  "status": "ok",
  "version": "0.1.0",
  "database": "connected",
  "uptime": 3600
}
```

Use this for load balancer health checks and uptime monitoring.

### Prometheus Metrics (if enabled)

If your Nexus build includes the metrics middleware, metrics are available at `/metrics`:

```bash
curl http://localhost:3100/metrics
```

Example Prometheus scrape config:

```yaml
scrape_configs:
  - job_name: nexus
    static_configs:
      - targets: ['localhost:3100']
    metrics_path: /metrics
    scheme: http
```

### Structured Logging

Set `LOG_LEVEL=info` (or `debug` for verbose output). Nexus logs structured JSON to stdout:

```json
{
  "level": "info",
  "time": "2026-04-03T04:34:00.000Z",
  "msg": "POST /api/projects/proj_01hx.../compile 200 143ms",
  "method": "POST",
  "path": "/api/projects/proj_01hx.../compile",
  "status": 200,
  "duration": 143
}
```

### Shipping Logs to a Log Aggregator

**With Docker and Loki:**

```yaml
# docker-compose.prod.yml
services:
  server:
    logging:
      driver: loki
      options:
        loki-url: "http://loki:3100/loki/api/v1/push"
        loki-labels: "app=nexus-server"
```

**With systemd and journald → Grafana:**

```bash
# Install promtail
sudo apt install promtail

# Configure /etc/promtail/config.yml
scrape_configs:
  - job_name: nexus
    journal:
      labels:
        job: nexus-server
      matches: _SYSTEMD_UNIT=nexus-server.service
```

### Alerting Rules

Key metrics to alert on:

| Alert | Condition | Severity |
|-------|-----------|----------|
| Server down | `/health` returns non-200 for > 1 min | Critical |
| High response latency | `p99 > 5s` for compile endpoint | Warning |
| Database connection exhaustion | Pool utilization > 90% | Warning |
| High contradiction count | `contradictions.count > 20` | Info |
| Embedding failure rate | Distillery error rate > 5% | Warning |

Example uptime check (cron-based):

```bash
#!/bin/bash
STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/health)
if [ "$STATUS" != "200" ]; then
  echo "Nexus server unhealthy (HTTP $STATUS)" | mail -s "ALERT: Nexus down" ops@yourdomain.com
fi
```

---

## Scaling Considerations

### Horizontal Server Scaling

The Nexus server is stateless — all state lives in PostgreSQL. You can run multiple server instances behind a load balancer:

```nginx
upstream nexus_api {
    least_conn;
    server 10.0.1.10:3100;
    server 10.0.1.11:3100;
    server 10.0.1.12:3100;
    keepalive 64;
}
```

Ensure all instances share the same `DATABASE_URL`, `OPENAI_API_KEY`, and `NEXUS_API_KEY`.

### PostgreSQL Read Replicas

For read-heavy workloads (context compilation is read-heavy), configure a replica:

```bash
# Primary
DATABASE_URL=postgresql://nexus:password@primary:5432/nexus

# Read replica for compile_context and search
DATABASE_READ_URL=postgresql://nexus:password@replica:5432/nexus
```

### Managed Database Services

Nexus works with any PostgreSQL 17 service that supports pgvector:

| Service | pgvector support | Notes |
|---------|-----------------|-------|
| Supabase | Yes | `CREATE EXTENSION vector` runs automatically |
| Neon | Yes | Enable in project settings |
| AWS RDS | Yes (pgvector extension) | Use `rds.force_ssl=1` |
| Google Cloud SQL | Yes | Enable `cloudsql.enable_pgvector` flag |
| Azure Database | Yes | Available in Flexible Server |

### Caching Layer

The context compiler uses a 1-hour in-memory cache keyed by `SHA-256(agent_id + "::" + task_description)`. For multi-instance deployments, this cache is per-process. To share the cache across instances, add Redis:

```bash
CACHE_PROVIDER=redis
REDIS_URL=redis://redis:6379
```

---

## Security Hardening

### API Key Authentication

Enable API key authentication by setting `NEXUS_API_KEY` in your environment. Create keys via the API:

```bash
curl -X POST http://localhost:3100/api/keys \
  -H "Content-Type: application/json" \
  -d '{"name": "production-agent", "project_id": "proj_01hx..."}'
```

Include the returned key in all subsequent requests:

```bash
curl http://localhost:3100/api/projects \
  -H "X-API-Key: nxk_..."
```

### Network Isolation

In Docker Compose, never expose PostgreSQL to the host in production:

```yaml
services:
  postgres:
    # No 'ports' mapping — only accessible within the Docker network
    expose:
      - "5432"
```

### Rate Limiting with Nginx

Add rate limiting to prevent abuse:

```nginx
# In the http block
limit_req_zone $binary_remote_addr zone=nexus_api:10m rate=30r/m;
limit_req_zone $binary_remote_addr zone=nexus_compile:10m rate=10r/m;

# In the server block
location /api/ {
    limit_req zone=nexus_api burst=20 nodelay;
    # ...
}

location /api/projects/*/compile {
    limit_req zone=nexus_compile burst=5 nodelay;
    # ...
}
```

### Firewall Rules

```bash
# Allow only nginx to access Nexus ports
sudo ufw allow from 127.0.0.1 to any port 3100
sudo ufw allow from 127.0.0.1 to any port 3200
sudo ufw deny 3100
sudo ufw deny 3200

# Allow nginx HTTP/HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

### Secrets Management

Never commit `.env` to version control. For production, use a secrets manager:

**AWS Secrets Manager:**

```bash
aws secretsmanager get-secret-value \
  --secret-id nexus/production \
  --query SecretString \
  --output text | jq -r 'to_entries | .[] | "\(.key)=\(.value)"' > /opt/nexus/.env
```

**HashiCorp Vault:**

```bash
vault kv get -format=json secret/nexus/production \
  | jq -r '.data.data | to_entries | .[] | "\(.key)=\(.value)"' > /opt/nexus/.env
```

---

## Upgrading Nexus

### Docker Compose Upgrade

```bash
# Pull latest code
git pull origin main

# Rebuild images
docker compose build

# Apply any new migrations (always before restarting).
# Docker initdb only runs on first database creation.
# Existing installations MUST run migrations manually on upgrade.
docker compose run --rm server pnpm db:migrate

# Rolling restart (minimizes downtime)
docker compose up -d --no-deps server
docker compose up -d --no-deps dashboard
```

### Manual Upgrade

```bash
git pull origin main
pnpm install
pnpm build

# Apply migrations
psql -U nexus -d nexus -f supabase/migrations/$(ls supabase/migrations/ | tail -1)

sudo systemctl restart nexus-server nexus-dashboard
```

### Migration Safety

Nexus migrations are always additive (no destructive DDL in migrations). Before upgrading:

1. Take a database backup
2. Review the migration files in `supabase/migrations/`
3. Test on a staging environment
4. Apply migrations before restarting the server

### Rollback

If a new version causes issues:

```bash
# Roll back to the previous Docker image tag
docker compose down
git checkout v0.1.0   # previous stable tag
docker compose up -d

# If migrations need reverting, restore from backup
```
