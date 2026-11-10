# pagesdata

pagesdata is a small local bridge to the hosted HasData
Yellow Pages MCP server, which returns Yellow Pages
business data as JSON. It can search for businesses
matching a keyword in a location, and it can pull one
listing in full from its URL: the business name, street
address, city, region and zip, coordinates, phone,
website, hours, payment methods, categories, ratings,
review counts, photos and service notes, along with
email and years in business on yellowpages.com
listings where the business itself publishes them.

The bridge keeps no directory of its own. It answers
the tool list locally, exactly as captured from the
live endpoint, and forwards each tool call upstream,
returning whatever comes back untouched. The captured
surface is two read-only fetches over listings that
businesses publish themselves: there is no write,
messaging, or payment tool in it.

## Tools

- `hasdata_yellowpages_search_getSearchResults` —
  run a Yellow Pages business search. Required:
  `keyword` and `location`. Optional: `sort`
  (`default` / `distance` / `averageRating` / `name`,
  the latter options applying on yellowpages.com),
  `domain` (`www.yellowpages.com` or
  `www.yellowpages.ca`), and `page` for pagination.
  Returns each business with name, listing URL, phone,
  address, categories, rating, review count, and years
  in business.
- `hasdata_yellowpages_place_getPlaceDetails` —
  fetch one listing in full. Required: `url` (the
  YellowPages listing URL). Returns name, street
  address, city, region, zip code, coordinates, phone,
  website, hours of operation, payment methods,
  categories, ratings, review counts, photos, and
  service descriptions, plus email and years in
  business on yellowpages.com listings. Fields the
  listing does not publish are omitted upstream.

## Configuration

- `HASDATA_YELLOWPAGES_MCP_URL` (optional) — override
  the upstream endpoint. Defaults to
  `https://mcp.hasdata.com/mcp?apis=yellowpages`. (The
  override hook is this rebuild's own labelled
  reconstruction.)
- `HASDATA_API_KEY` (optional) — when set, every
  upstream request carries an `x-api-key: <key>`
  header, for the caller's own HasData API key. When
  it is not set, no key header is sent. (The header
  name and the env name are pinned by the original's
  registry record; forwarding the key from this env
  var is a labelled reconstruction — the original
  surface was captured keyless.)

### Forwarding mechanics

On the first tool call the client opens a streamable
HTTP session upstream: a JSON-RPC `initialize` request
(protocolVersion `2025-03-26`, clientInfo name
`pagesdata`), then a `notifications/initialized`
notification, then the `tools/call` request carrying
the caller's arguments unchanged. When the upstream
answers `initialize` with an `Mcp-Session-Id` header,
that value rides on every later request of the
session, which is reused for the life of the process.
Replies may arrive as plain JSON or as server-sent
events; both are read.

Successful upstream results pass through verbatim,
including any `isError` flag the upstream sets.
Failures — a JSON-RPC error, a non-2xx status, an
unreadable response, or a request that cannot be
completed — come back as an `isError` result whose
text starts with `pagesdata error:` (this rendering
is this rebuild's own labelled reconstruction).

## CLI

Each tool is also a subcommand taking one JSON
argument string:

```bash
npx @reneturcios/pagesdata hasdata_yellowpages_search_getSearchResults '{"keyword":"plumber","location":"Austin, Texas"}'
npx @reneturcios/pagesdata hasdata_yellowpages_place_getPlaceDetails '{"url":"https://www.yellowpages.com/austin-tx/example"}'
npx @reneturcios/pagesdata --version
```

Exit codes: `0` on success, `1` on an `isError`
result, `2` on a usage error.

## MCP server

```bash
npx -y @reneturcios/pagesdata mcp
```

MCP client config:

```json
{
  "mcpServers": {
    "pagesdata": {
      "command": "npx",
      "args": ["-y", "@reneturcios/pagesdata", "mcp"]
    }
  }
}
```

## Docker

```bash
docker run -i ghcr.io/cloudcorprecords/pagesdata
docker run --rm ghcr.io/cloudcorprecords/pagesdata --version
```

The container's default command is `mcp`, so the first
form is a stdio MCP server; any other arguments reach
the CLI normally.

## Development

```bash
npm install
npm run build
npm test
npm run dev
```

The test suite runs entirely against a stubbed
JSON-RPC upstream — no live network calls.

## License

MIT — see `LICENSE`.
