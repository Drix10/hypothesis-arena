#!/bin/bash
# Freeze v3 O2 pre-commit hook. Install: ln -sf ../../scripts/pre-commit-secrets.sh .git/hooks/pre-commit
# Requires gitleaks on PATH (CI pins the release by SHA-256; see ci.yml).
set -e
cd "$(git rev-parse --show-toplevel)"
if ! command -v gitleaks >/dev/null; then
    echo "pre-commit: gitleaks not installed; refusing to commit unscanned (AGENTS.md rule 4)" >&2
    exit 1
fi
gitleaks protect --staged --redact --no-banner -c .gitleaks.toml
