#!/bin/bash
# ════════════════════════════════════════════════════════════════════
# install.sh — DreamLine SalesBot v23.0
# One-command installer for fresh setup
#
# Usage:
#   chmod +x install.sh
#   ./install.sh
#
# What this does:
#   1. Checks system requirements (Node 18+, npm)
#   2. Installs all npm packages
#   3. Runs the setup wizard (copies .env, generates keys)
#   4. Prints next steps
# ════════════════════════════════════════════════════════════════════

set -e

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
CYAN="\033[36m"
RESET="\033[0m"

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║   DreamLine SalesBot v23.0 — Installer               ║${RESET}"
echo -e "${BOLD}║   AI WhatsApp Business Automation System              ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════╝${RESET}"
echo ""

# ── Check Node.js ─────────────────────────────────────────────────
echo -e "${CYAN}→ Checking Node.js...${RESET}"
if ! command -v node &> /dev/null; then
    echo -e "${RED}✗ Node.js not found. Download at: https://nodejs.org (v18+)${RESET}"
    exit 1
fi

NODE_VER=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_VER" -lt 18 ]; then
    echo -e "${RED}✗ Node.js 18+ required. You have $(node --version). Download at https://nodejs.org${RESET}"
    exit 1
fi
echo -e "${GREEN}✓ Node.js $(node --version) — OK${RESET}"

# ── Check npm ─────────────────────────────────────────────────────
echo -e "${CYAN}→ Checking npm...${RESET}"
if ! command -v npm &> /dev/null; then
    echo -e "${RED}✗ npm not found. It should come with Node.js.${RESET}"
    exit 1
fi
echo -e "${GREEN}✓ npm $(npm --version) — OK${RESET}"

# ── Check .env.example exists ─────────────────────────────────────
echo ""
echo -e "${CYAN}→ Checking environment template...${RESET}"
if [ ! -f ".env.example" ]; then
    echo -e "${RED}✗ .env.example not found. Please restore it from the repository.${RESET}"
    exit 1
fi
echo -e "${GREEN}✓ .env.example found${RESET}"

# ── Install packages ──────────────────────────────────────────────
echo ""
echo -e "${CYAN}→ Installing npm packages...${RESET}"
npm install
echo -e "${GREEN}✓ All packages installed${RESET}"

# ── Run setup wizard ──────────────────────────────────────────────
echo ""
echo -e "${CYAN}→ Running setup wizard...${RESET}"
node scripts/setup.js

echo ""
echo -e "${BOLD}${GREEN}═══════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}${GREEN}  Installation complete!${RESET}"
echo -e "${BOLD}${GREEN}═══════════════════════════════════════════════════════${RESET}"
echo ""
echo -e "${YELLOW}Next: edit .env.development.local and run: npm run dev${RESET}"
echo ""
