#!/bin/sh
# Vite dev server in a container on http://localhost:5173
set -e
cd "$(dirname "$0")/.."
# Interactive only when attached to a terminal (agents and CI have no TTY).
TTY=
if [ -t 0 ]; then TTY=-it; fi
exec docker run --rm $TTY -p 5173:5173 -v "$PWD":/app -v nyfpt_node_modules:/app/node_modules -w /app node:24-alpine npm run dev -- --host 0.0.0.0
