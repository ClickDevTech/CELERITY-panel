#!/bin/bash
# Build cc-agent for Linux AMD64 (typical VPS) and FreeBSD AMD64
# Run: bash build.sh
set -e

echo "=== Building cc-agent ==="

# Fetch dependencies
go mod tidy

# Build for Linux AMD64
GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o cc-agent-linux-amd64 .

echo "Done: cc-agent-linux-amd64 built ($(du -sh cc-agent-linux-amd64 | cut -f1))"

# Build for FreeBSD AMD64 (served to nodes via CC_AGENT_FREEBSD_URL)
GOOS=freebsd GOARCH=amd64 go build -ldflags="-s -w" -o cc-agent-freebsd-amd64 .

echo "Done: cc-agent-freebsd-amd64 built ($(du -sh cc-agent-freebsd-amd64 | cut -f1))"

# Optional: build for Linux ARM64
# GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o cc-agent-linux-arm64 .
