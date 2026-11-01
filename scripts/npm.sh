#!/bin/sh
# Run npm inside a container; node/npm are never run on the host.
set -e
cd "$(dirname "$0")/.."
exec docker run --rm -v "$PWD":/app -v nyfpt_node_modules:/app/node_modules -w /app node:24-alpine npm "$@"
