# nyfpt

Yahoo-Finance-style portfolio PWA for Tradernet / Freedom Broker clients. Vue 3 + Vite.
Public site: https://portfolio.zigmund.xyz/

## No backend: your data never touches our servers

There is no application backend. The server only hands out static files (HTML, JS, CSS,
icons) through nginx. Everything else happens in your browser:

- Your login, password, SMS / push code, session ID and all account data go from the browser
  straight to Tradernet (`https://tradernet.global/api/` and `wss://wss.tradernet.global/`).
  They do not pass through the server that hosts the app and are not stored on it.
- Cached data lives only in your browser: the session and display preferences and recent
  searches in localStorage, cached broker data in IndexedDB. `Settings -> Clear cache` deletes
  the cached account data (IndexedDB). `Settings -> Log out` also forgets the broker session
  and recent searches; only display preferences (theme, hidden amounts, period, sorting,
  markets strip and open/closed sections) stay on the device.
- Access is read-only: login always uses `viewOnlyMode: true`.

You can check this yourself:

- The Content-Security-Policy (`nginx/security-headers.inc`) has
  `connect-src 'self' https://tradernet.global wss://wss.tradernet.global`, so the browser
  refuses to send requests anywhere else. The only `'self'` requests are for static files and
  the service worker, which caches only those files from our own origin and never touches
  broker requests or data.
- No analytics, trackers, CDN or external fonts, and no automatic third-party requests. News
  items may contain links; they open only when you click them (`Referrer-Policy: no-referrer`).
- DevTools -> Network shows every request the app makes.
- The code is open. You can run your own copy (see "Run locally in Docker" below:
  `docker run --rm -p 8080:8080 zigmund/nyfpt`), and then even the static files do not come
  from anyone else's server.

To be precise: like any web server, the one behind https://portfolio.zigmund.xyz/ sees ordinary
HTTP requests for static files (IP address, User-Agent, path), but no account data. Your data
is held by the broker and falls under the broker's policy.

Calculation rules: `docs/CALCULATIONS.md`. UI notes: `docs/UI.md`. Decisions: `docs/DECISIONS.md`.
Broker API reference: `docs/tradernet-api.md`.

## Features

- Login with email/login and password, or with a phone number and an SMS / push code.
  USD accounts only.
- Main screen: portfolio value with a Performance / Value chart and a period picker
  (`1D 7D 1M 6M YTD 1Y 5Y ALL`), live quotes over WebSocket, a configurable markets strip.
- Holdings table with Day and Period views, a Cash row, and closed positions.
- Contributions of each holding to the result, and a cash flows card (deposits, dividends,
  taxes, commissions, trades).
- Comparison of the portfolio with S&P 500 and Nasdaq 100 (via SPY and QQQ).
- Security screen: quote, price chart, your position, key statistics, and news.
- Ticker search with recent searches; securities can be added to the markets strip.
- Hide amounts (the eye button), light / dark / system theme, strip editor, clear cache, log out.
- Installable as a PWA (service worker, web manifest). The interface is English only.

## Security model

How data flows and what is stored is described in "No backend" above. In addition:

- Your password and SMS / push code are never stored (not in localStorage, not in IndexedDB)
  and never sent anywhere except the broker.
- Broker data is rendered only through Vue interpolation; `v-html` is not used for it.
- `nginx/security-headers.inc` also sets `script-src` and `style-src` to `'self'` only,
  `X-Content-Type-Options: nosniff`, a restrictive `Permissions-Policy`, and
  `frame-ancestors 'none'`.

## Run locally in Docker

Requires Docker only (Node is not needed on the host). The image serves the built `dist/` with
nginx as a non-root user on port 8080.

Prebuilt image (linux/amd64 and linux/arm64, published by CI from main and release tags):

```sh
docker run --rm -p 8080:8080 zigmund/nyfpt
```

- Tags: `latest` is the main branch; release versions are `X.Y.Z` (from git tags `vX.Y.Z`)
  and `sha-xxxxxxx` are commit tags.
- Hardened variant with a read-only root filesystem: `docker run --rm --read-only --tmpfs /tmp -p 8080:8080 zigmund/nyfpt`.
- Image page: https://hub.docker.com/r/zigmund/nyfpt

Or build from source. The build runs the tests (the build fails if they fail):

```sh
docker build -t nyfpt .
docker run --rm -p 8080:8080 nyfpt
```

Open http://localhost:8080/ and log in with your broker account. Health check:
`curl http://localhost:8080/health` returns `ok`.

- Optional version label (shown in Settings): `docker build --build-arg APP_VERSION=1.0 -t nyfpt .`
  (default `dev`).
- Another host port: `-p 18080:8080`, then open http://localhost:18080/.
- The source build also runs with a read-only root filesystem:
  `docker run --rm --read-only --tmpfs /tmp -p 8080:8080 nyfpt`.
- Run in the background: add `-d --name nyfpt`, stop with `docker stop nyfpt`.
- On Apple Silicon no `--platform` flag is needed for either option.
- The `?mock` fake broker is a dev-server feature only; it is not in the production image.
  To try the app without an account, use `./scripts/serve.sh` (see below).

Notes on login from `localhost`: the broker API answers cross-origin requests from
`http://localhost:<port>` with a matching `Access-Control-Allow-Origin` header (checked with
`curl`), so the browser should accept them. A full login from a locally served copy was not
tested, because it needs real credentials. Service workers and the PWA install work on
`localhost`, but a plain `http://` address other than `localhost` is not a secure context.

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

Open http://localhost:5173/?mock for the dev server with a fake broker on synthetic data:
any login and password work, no account needed.

Tests use only synthetic data (`tests/fixtures/synthetic-api.json`). The optional
`tests/real-fixtures.local.test.js` runs only if a private, git-ignored fixture folder exists
locally and is skipped otherwise.
