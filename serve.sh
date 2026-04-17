#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Rosie Portal
# Default: http://127.0.0.1:8789/
# Override: PORT=8790 ./serve.sh

export PORT=${PORT:-8789}
export HOST=${HOST:-127.0.0.1}

node "./server.mjs"
