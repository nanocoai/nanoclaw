#!/bin/bash
# NanoClaw Setup Script for macOS (Apple Containers)
# Usage: Open Terminal, cd to this folder, and run: bash install.sh

set -e

echo "============================================"
echo "  NanoClaw Installer for macOS"
echo "============================================"
echo ""

# Check for macOS
if [[ "$(uname)" != "Darwin" ]]; then
    echo "❌ This script is designed for macOS. Exiting."
    exit 1
fi

# Check for Git
if ! command -v git &> /dev/null; then
    echo "❌ Git not found. Install Xcode CLI tools: xcode-select --install"
    exit 1
fi
echo "✅ Git found"

# Check for Node.js 20+
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VERSION" -ge 20 ]; then
        echo "✅ Node.js $(node -v) found"
    else
        echo "❌ Node.js 20+ required (found $(node -v)). Install from https://nodejs.org"
        exit 1
    fi
else
    echo "❌ Node.js not found. Install from https://nodejs.org"
    exit 1
fi

# Check for Claude Code
if command -v claude &> /dev/null; then
    echo "✅ Claude Code found"
else
    echo "❌ Claude Code not found. Install with: npm install -g @anthropic-ai/claude-code"
    exit 1
fi

# Check for container runtime
if command -v container &> /dev/null; then
    echo "✅ Apple Containers found"
    RUNTIME="apple"
elif command -v docker &> /dev/null; then
    echo "✅ Docker found"
    RUNTIME="docker"
else
    echo "⚠️  No container runtime found."
    echo "   Option A: Update to macOS 26 (Tahoe) for Apple Containers"
    echo "   Option B: Install Docker Desktop from https://docker.com"
    exit 1
fi

echo ""
echo "============================================"
echo "  All prerequisites met! (Runtime: $RUNTIME)"
echo "============================================"
echo ""

# Initialize git repo if needed (files were copied without .git)
if [ ! -d ".git" ]; then
    echo "📦 Initializing git repository..."
    git init
    git remote add origin https://github.com/qwibitai/nanoclaw.git
    git fetch origin
    git reset origin/main
    echo "✅ Git repository initialized"
fi

# Install npm dependencies
echo "📦 Installing dependencies..."
npm install
echo "✅ Dependencies installed"

echo ""
echo "============================================"
echo "  Ready! Next steps:"
echo "============================================"
echo ""
echo "  1. Run 'claude' in this directory"
echo "  2. Inside Claude Code, type: /setup"
echo "  3. To add WhatsApp, type: /add-whatsapp"
echo ""
echo "  Enjoy NanoClaw! 🦞"
echo ""
