# nyfpt

Yahoo-Finance-style portfolio PWA for Tradernet / Freedom Broker clients. Vue 3 + Vite;
all data is fetched in the browser straight from the broker API and cached locally.

Calculation rules: `docs/CALCULATIONS.md`. UI notes: `docs/UI.md`. Decisions: `docs/DECISIONS.md`.
Broker API reference: `docs/tradernet-api.md`.

## Development

Node and npm are never run on the host. Every command goes through a `node:24-alpine`
container (`node_modules` lives in the docker volume `nyfpt_node_modules`; docker may leave
an empty `node_modules/` mount point in the working tree, it is git-ignored).

```sh
./scripts/npm.sh install        # install dependencies
./scripts/npm.sh test           # vitest run
./scripts/npm.sh run build      # production build into dist/
./scripts/serve.sh              # dev server on http://localhost:5173
```

Tests use only synthetic data (`tests/fixtures/synthetic-api.json`). The optional
`tests/real-fixtures.local.test.js` runs only if a private, git-ignored fixture folder exists
locally and is skipped otherwise.

## Building the image

Not part of this scaffold yet; the build output is the static `dist/` directory.
