#!/bin/bash
set -e
cd /opt/nexus

echo "[deploy] Pulling latest..."
git stash 2>/dev/null || true
git pull --rebase origin main

echo "[deploy] Fixing docker-compose.yml..."
git checkout HEAD -- docker-compose.yml

python3 << 'PYEOF'
import re
with open('docker-compose.yml') as f:
    lines = f.readlines()
new_lines = []
for line in lines:
    new_lines.append(line)
    if 'OPENAI_API_KEY: ${OPENAI_API_KEY:-}' in line:
        indent = '      '
        new_lines.append(f'{indent}DECIGRAPH_OPENCLAW_PATH: ${{DECIGRAPH_OPENCLAW_PATH:-}}\n')
        new_lines.append(f'{indent}DECIGRAPH_DEFAULT_PROJECT_ID: ${{DECIGRAPH_DEFAULT_PROJECT_ID:-}}\n')
        new_lines.append(f'{indent}DECIGRAPH_TELEGRAM_BOT_TOKEN: ${{DECIGRAPH_TELEGRAM_BOT_TOKEN:-}}\n')
    if 'supabase/migrations:/app/supabase/migrations:ro' in line:
        new_lines.append('      - /docker/openclaw-okny/data/.openclaw:/docker/openclaw-okny/data/.openclaw:ro\n')
with open('docker-compose.yml', 'w') as f:
    f.writelines(new_lines)
text = open('docker-compose.yml').read()
if 'external: true' not in text:
    text = text.replace('  nexus_nexus_pgdata:', '  nexus_nexus_pgdata:\n    external: true')
text = text.replace('condition: service_started', 'condition: service_healthy')
text = re.sub(r'(decigraph-dashboard.*?server:\s*\n\s*)condition: service_healthy', r'\1condition: service_started', text, flags=re.DOTALL)
text = re.sub(r'VITE_API_URL:.*', 'VITE_API_URL: ""', text)
open('docker-compose.yml', 'w').write(text)
PYEOF

echo "[deploy] Building..."
docker compose build --no-cache server

echo "[deploy] Restarting..."
docker compose down && docker compose up -d

echo "[deploy] Waiting for health..."
sleep 15

echo "[deploy] Status:"
curl -s http://localhost:3100/api/status | python3 -c "
import json,sys
d=json.load(sys.stdin)
s=d['system']
print(f'  Version: {d.get(\"version\")}')
print(f'  Decisions: {s[\"decisions\"]}')
print(f'  Watcher: {s[\"openclaw\"][\"watching\"]}')
print(f'  Queues: {s[\"queues\"][\"mode\"]}')
" 2>/dev/null || echo "  Server not responding!"

echo "[deploy] Done."
