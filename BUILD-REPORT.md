# BUILD REPORT — pagesdata

Rebuild of `com.hasdata/yellowpages` v1.0.2 (remote-only, keyless capture)
as `@reneturcios/pagesdata` 0.1.0 / `io.github.CloudCorpRecords/pagesdata`.

## Fixture conflicts

**None.** The brief, the spec prose, and the fixture agree on both tool
names and their required fields. Required fields as served, taken from
the fixture (`harness/fixtures/hasdata-yellowpages-tools-original.json`):

- `hasdata_yellowpages_place_getPlaceDetails` — required: `url`
- `hasdata_yellowpages_search_getSearchResults` — required: `keyword`, `location`

The fixture's tool literals (name, title, description, inputSchema —
including the `title` keys, every property description and enum,
`additionalProperties: false`, and the `$schema` key) are served
verbatim from `src/forward.ts`; the literals were generated
programmatically from the fixture JSON (parsed and re-serialised, not
retyped) and verified by the registration-integrity test (served
tools/list deep-equals the fixture's 2 tool objects) and again by the
parity harness.

## What was built

All 19 factory files under `builds/pagesdata/`:

- `package.json` (`@reneturcios/pagesdata` 0.1.0, bin
  `pagesdata` → `dist/cli.js`, deps exactly `@modelcontextprotocol/sdk ^1`
  + `zod ^3`; devDeps `@types/node ^20`, `tsx ^4`, `typescript ^5`)
- `server.json` (description exactly the prescribed 94-char string
  "Yellow Pages business data as JSON: search by keyword and location, plus full listing details.";
  npm entry carries `"version": "0.1.0"`; OCI entry
  `ghcr.io/cloudcorprecords/pagesdata:0.1.0` carries **no** version field)
- `Dockerfile` (node:20-alpine both stages; server-name label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/pagesdata"`
  matches `server.json`)
- `tsconfig.json` (fleet-identical, 318 bytes), `.gitignore`,
  `package-lock.json`, `README.md` (fresh prose), `LICENSE` (MIT,
  Copyright (c) 2026 Rene Turcios), `CHANGELOG.md` (single 0.1.0 entry,
  2026-10-28)
- `src/index.ts`, `src/cli.ts`, `src/mcp.ts`, `src/types.ts`,
  `src/forward.ts` (core; exports `VERSION = "0.1.0"`)
- `test/forward.test.ts`
- `.github/workflows/{ci.yml, publish.yml, publish-container.yml,
  registry-publish.yml}` (container workflow: IMAGE
  `ghcr.io/cloudcorprecords/pagesdata`, smoke assertion on server name
  `pagesdata`)

Plus `BUILD-REPORT.md` (this file) and the `parity-out/` harness output.

## Design

- Forwarding client to `https://mcp.hasdata.com/mcp?apis=yellowpages`
  (pinned; the query string is part of the pinned URL), overridable via
  `HASDATA_YELLOWPAGES_MCP_URL` (labelled reconstruction). tools/call is
  forwarded as a streamable-HTTP JSON-RPC client: initialize
  (protocolVersion `2025-03-26`, clientInfo `pagesdata`) →
  notifications/initialized → tools/call, honouring `Mcp-Session-Id`
  when issued; session established lazily and reused per client.
  Plain-JSON and SSE replies both parsed; the matching-id message
  wins; upstream results pass through verbatim (including `isError`
  and extra fields such as `structuredContent`).
- When `HASDATA_API_KEY` is set, an `x-api-key` header is
  sent on every upstream request (header name pinned by the registry
  record's remote declaration; forwarding it from this env var is a
  labelled reconstruction — the capture was keyless). When unset, no
  key header is sent. No `Authorization` header is sent in either
  case. Both branches are covered by tests.
- Upstream failures (JSON-RPC error, non-2xx status, malformed body,
  throwing/timing-out fetch) surface as `pagesdata error:` text
  results (labelled reconstruction).
- Registration via the MCP SDK **low-level** `Server` API
  (`ListToolsRequestSchema` / `CallToolRequestSchema` handlers) serving
  the fixture literals exactly; no `McpServer` + zod registration
  (per the task brief, overriding TEMPLATE.md §2 item 12).
  `src/mcp.ts` also exports `createServer` / `startMcpServer` /
  `handleCallTool` so the MCP layer is testable without a transport;
  the CLI's `mcp` subcommand starts it over stdio.
- Core takes an injectable fetch (`ForwardDeps.fetchFn`), so all tests
  run against a stubbed JSON-RPC upstream. No live network calls in
  tests; no live call claimed anywhere. The captured surface is two
  read-only fetches over published Yellow Pages business listings
  (business-published NAP data); no write, messaging, or payment tool
  exists in the surface — none was added.

## Lockfile (Route 3, clean from birth)

Generated in a temp dir (`/tmp/pagesdata-lock`) containing only the
new `package.json`, with no `node_modules` present:
`npm install --package-lock-only --ignore-scripts --offline`.
Verified: parses, `name == @reneturcios/pagesdata`,
**128 package entries**; placed into the build dir with matching
sha256 (`abc25838…f5562` on both sides: full value
`abc2583851c527d0412932e105a6d53b4cc4616f9cecfe938510be04348f5562`).
Then `npm install --offline --ignore-scripts` in the build dir for
`node_modules`.

## Verification (all in the build dir unless noted)

- `npx tsc --noEmit` → exit 0
- `npm run build` → real `dist/` (cli.js, forward.js, mcp.js, all
  non-empty, with `.d.ts` + source maps)
- `node dist/cli.js --version` → `0.1.0`; unknown subcommand → usage on
  stderr, exit 2
- `npm test` → **52 tests, 52 pass, 0 fail** (8 suites: registration
  integrity — served tools deep-equal the fixture's full 2 tool
  objects, names in order, exactly the fixture's keys incl. title,
  required fields per tool, every property key in order, search
  sort/domain enums, additionalProperties/$schema, isKnownTool; session
  establishment/reuse/session-id handling, clientInfo/protocol
  version; env URL override, explicit url override, explicit-over-env
  precedence, blank-env fallback; x-api-key header present on every
  request when the key is set / absent when unset / no Authorization
  header in either case; verbatim argument forwarding for both tools
  incl. a fully-specified search and a minimal search;
  verbatim result pass-through incl. upstream isError and SSE;
  JSON-RPC/init/malformed/no-result/HTTP/throw/timeout failures →
  `pagesdata error:`; parseRpcBody JSON + SSE + matching-id + [DONE]
  cases; MCP-layer MethodNotFound / InvalidParams validation; CLI
  --version / -v / unknown exit 2 / bad-JSON exit 2 / `mcp extra` exit 2)
- Parity: `python3 harness/parity.py --original
  harness/fixtures/hasdata-yellowpages-tools-original.json --rebuild
  "stdio:node builds/pagesdata/dist/cli.js mcp" --out
  builds/pagesdata/parity-out` (run from `~/workspace/mcp-rebuild-100`)
  → **PASS, parity 100.0, 2/2 identical, no missing/extra/schema
  diffs** (see `parity-out/parity.json`)
- Consistency sweep: package.json version = server.json top-level =
  npm-entry version = OCI tag = core `VERSION` = CHANGELOG heading
  (0.1.0); package.json `mcpName` = server.json `name` = Dockerfile
  label; server.json description measured at 94 chars; OCI entry
  confirmed to have no `version` field.

Clean-room: all prose and code written fresh for pagesdata; only the
mechanics were patterned on the sibling glassdata build, and only the
fixture's tool literals are served verbatim.
