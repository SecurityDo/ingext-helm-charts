#!/usr/bin/env bash

set -euo pipefail

BASE_DIR="skills/lakehouse-aws"

echo "Creating Lakehouse AWS skill scaffold at: $BASE_DIR"

# Create directories
mkdir -p \
  "$BASE_DIR/src/tools" \
  "$BASE_DIR/src/steps" \
  "$BASE_DIR/bin"

# Top-level files
touch \
  "$BASE_DIR/README.md" \
  "$BASE_DIR/package.json" \
  "$BASE_DIR/tsconfig.json"

# Source files
touch \
  "$BASE_DIR/src/index.ts" \
  "$BASE_DIR/src/skill.ts" \
  "$BASE_DIR/src/schema.ts" \
  "$BASE_DIR/src/types.ts"

# Tool wrappers
touch \
  "$BASE_DIR/src/tools/shell.ts" \
  "$BASE_DIR/src/tools/aws.ts" \
  "$BASE_DIR/src/tools/dns.ts" \
  "$BASE_DIR/src/tools/file.ts"

# Skill steps (preflight phases)
touch \
  "$BASE_DIR/src/steps/auth.ts" \
  "$BASE_DIR/src/steps/collect.ts" \
  "$BASE_DIR/src/steps/checks.ts" \
  "$BASE_DIR/src/steps/writeEnv.ts"

# CLI entrypoint
touch \
  "$BASE_DIR/bin/run.ts"

echo "✅ Lakehouse AWS skill scaffold created."
echo ""
echo "Next steps:"
echo "  1. cd $BASE_DIR"
echo "  2. Open in Cursor"
echo "  3. Start filling in schema.ts and skill.ts"
