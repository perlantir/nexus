#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}"
echo "  _   _                      "
echo " | \ | | _____  ___   _ ___  "
echo " |  \| |/ _ \ \/ / | | / __| "
echo " | |\  |  __/>  <| |_| \__ \ "
echo " |_| \_|\___/_/\_\\__,_|___/ "
echo -e "${NC}"
echo "DeciGraph Installer v1.0"
echo "================================"
echo ""

echo -e "${BLUE}Checking prerequisites...${NC}"

if ! command -v docker &> /dev/null; then
    echo -e "${RED}Error: Docker is not installed.${NC}"
    echo "Install Docker first: https://docs.docker.com/get-docker/"
    exit 1
fi

if ! command -v docker compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo -e "${RED}Error: Docker Compose is not installed.${NC}"
    echo "Install Docker Compose: https://docs.docker.com/compose/install/"
    exit 1
fi

if ! command -v git &> /dev/null; then
    echo -e "${RED}Error: Git is not installed.${NC}"
    echo "Install Git: sudo apt install git"
    exit 1
fi

if ! command -v jq &> /dev/null; then
    echo -e "${YELLOW}Warning: jq is not installed. Installing...${NC}"
    sudo apt-get install -y jq 2>/dev/null || sudo yum install -y jq 2>/dev/null || true
fi

echo -e "${GREEN}All prerequisites met${NC}"
echo ""

INSTALL_DIR="${DECIGRAPH_INSTALL_DIR:-/opt/decigraph}"
echo -e "${BLUE}Install directory: ${INSTALL_DIR}${NC}"

if [ -d "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}Directory already exists. Updating...${NC}"
    cd "$INSTALL_DIR"
    git pull origin main
else
    echo "Cloning DeciGraph..."
    git clone https://github.com/perlantir/decigraph.git "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

echo ""

echo -e "${BLUE}Configuration${NC}"
echo "============="
echo ""

if [ -f .env ] && grep -q "DECIGRAPH_API_KEY" .env; then
    echo -e "${GREEN}Existing .env found — keeping current config${NC}"
    source .env 2>/dev/null || true
else
    DECIGRAPH_KEY="nx_$(openssl rand -hex 20)"
    echo -e "Generated DECIGRAPH_API_KEY: ${GREEN}${DECIGRAPH_KEY}${NC}"
    echo -e "${YELLOW}Save this key — your agents will use it to connect to DeciGraph${NC}"
    echo ""

    echo "DeciGraph can use an LLM for semantic search and auto-extraction."
    echo "This is optional — DeciGraph works without it."
    echo ""
    echo "Enter your OpenRouter API key (or press Enter to skip):"
    read -r OPENROUTER_KEY

    cat > .env << ENVEOF
DECIGRAPH_API_KEY=${DECIGRAPH_KEY}
ENVEOF

    if [ -n "$OPENROUTER_KEY" ]; then
        echo "OPENROUTER_API_KEY=${OPENROUTER_KEY}" >> .env
    fi

    echo ""
    echo -e "${GREEN}Configuration saved to .env${NC}"
fi

echo ""

echo -e "${BLUE}Starting DeciGraph...${NC}"
docker compose up -d --build 2>&1 | tail -5

echo ""
echo "Waiting for DeciGraph to start..."
MAX_WAIT=120
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
    if curl -s http://localhost:3100/api/health | grep -q '"ok"' 2>/dev/null; then
        break
    fi
    sleep 2
    WAITED=$((WAITED + 2))
    echo -n "."
done
echo ""

if [ $WAITED -ge $MAX_WAIT ]; then
    echo -e "${RED}DeciGraph did not start within ${MAX_WAIT}s${NC}"
    echo "Check logs: docker compose logs server"
    exit 1
fi

echo ""
echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}  DeciGraph is running!${NC}"
echo -e "${GREEN}================================${NC}"
echo ""

HEALTH=$(curl -s http://localhost:3100/api/health)
VERSION=$(echo "$HEALTH" | jq -r .version 2>/dev/null || echo "unknown")

echo -e "  API:        ${GREEN}http://localhost:3100${NC}"
echo -e "  Dashboard:  ${GREEN}http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost'):3200${NC}"
echo -e "  Version:    ${VERSION}"

LOGS=$(docker compose logs server 2>/dev/null | tail -10)
if echo "$LOGS" | grep -q "Embeddings:.*via"; then
    EMB=$(echo "$LOGS" | grep "Embeddings:" | tail -1 | sed 's/.*Embeddings: //')
    echo -e "  Embeddings: ${GREEN}${EMB}${NC}"
else
    echo -e "  Embeddings: ${YELLOW}disabled (text search fallback)${NC}"
fi
if echo "$LOGS" | grep -q "Distillery:.*via"; then
    DIST=$(echo "$LOGS" | grep "Distillery:" | tail -1 | sed 's/.*Distillery: //')
    echo -e "  Distillery: ${GREEN}${DIST}${NC}"
else
    echo -e "  Distillery: ${YELLOW}disabled (manual recording only)${NC}"
fi

echo ""
echo -e "  ${BLUE}Open the dashboard to set up your first project:${NC}"
echo -e "  ${GREEN}http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost'):3200${NC}"
echo ""
echo -e "  Your API key: ${YELLOW}$(grep DECIGRAPH_API_KEY .env | cut -d= -f2)${NC}"
echo ""
echo "  Docs:  https://github.com/perlantir/decigraph/blob/main/docs/getting-started.md"
echo ""
