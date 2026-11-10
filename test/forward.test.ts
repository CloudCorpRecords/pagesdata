import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  PagesdataClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * All tests run against a stubbed JSON-RPC upstream that
 * implements the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, and the real HasData endpoint is never
 * contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/hasdata-yellowpages-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Publish-survival guard (Wave 25 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const PLACE_TOOL = "hasdata_yellowpages_place_getPlaceDetails";
const SEARCH_TOOL = "hasdata_yellowpages_search_getSearchResults";

const SAMPLE_RESULT = {
  content: [{ type: "text", text: "{\"businesses\":[],\"count\":0}" }],
  structuredContent: { count: 0 },
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-xyz" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "hasdata-yellowpages", version: "1.0.2" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new PagesdataClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

/* ------------------------------------------------------------------ */

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 2 tools, deep-equal", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 2);
    assert.deepEqual(TOOL_DEFS, fixture.tools);
  });

  it("serves the 2 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, [
      "hasdata_yellowpages_place_getPlaceDetails",
      "hasdata_yellowpages_search_getSearchResults",
    ]);
  });

  it("carries exactly the fixture's keys on each tool", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
        "title",
      ]);
    }
  });

  it("carries the title keys, as captured", () => {
    assert.equal(TOOL_DEFS[0].title, "yellowpages_place: GET /");
    assert.equal(TOOL_DEFS[1].title, "yellowpages_search: GET /");
  });

  it("carries exactly the fixture's required fields per tool", () => {
    assert.deepEqual(
      (TOOL_DEFS[0].inputSchema as { required?: string[] }).required,
      ["url"],
    );
    assert.deepEqual(
      (TOOL_DEFS[1].inputSchema as { required?: string[] }).required,
      ["keyword", "location"],
    );
  });

  it("carries every fixture property, in order, for both tools", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < 2; i += 1) {
      const served = Object.keys(
        (TOOL_DEFS[i].inputSchema as { properties: object }).properties,
      );
      const expected = Object.keys(
        (fixture.tools[i].inputSchema as { properties: object }).properties,
      );
      assert.deepEqual(served, expected);
    }
    assert.deepEqual(
      Object.keys((TOOL_DEFS[0].inputSchema as { properties: object }).properties),
      ["url"],
    );
    assert.deepEqual(
      Object.keys((TOOL_DEFS[1].inputSchema as { properties: object }).properties),
      ["keyword", "location", "sort", "domain", "page"],
    );
  });

  it("carries the fixture's search enums verbatim", () => {
    const props = (
      TOOL_DEFS[1].inputSchema as {
        properties: Record<string, { enum?: unknown[] }>;
      }
    ).properties;
    assert.deepEqual(props.sort.enum, [
      "default",
      "distance",
      "averageRating",
      "name",
    ]);
    assert.deepEqual(props.domain.enum, [
      "www.yellowpages.com",
      "www.yellowpages.ca",
    ]);
  });

  it("carries additionalProperties false and the draft-07 $schema on both tools", () => {
    for (const tool of TOOL_DEFS) {
      const schema = tool.inputSchema as Record<string, unknown>;
      assert.equal(schema.additionalProperties, false);
      assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
      assert.equal(schema.type, "object");
    }
  });

  it("isKnownTool recognises both captured tools and rejects others", () => {
    assert.equal(isKnownTool(PLACE_TOOL), true);
    assert.equal(isKnownTool(SEARCH_TOOL), true);
    assert.equal(isKnownTool("hasdata_yellowpages_other"), false);
    assert.equal(isKnownTool(""), false);
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool(SEARCH_TOOL, { keyword: "plumber", location: "Austin, Texas" });
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://mcp.hasdata.com/mcp?apis=yellowpages");
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(call.headers["Accept"], "application/json, text/event-stream");
    }
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-xyz");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-xyz");
  });

  it("sends clientInfo name pagesdata and the pinned protocol version on initialize", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(PLACE_TOOL, { url: "https://www.yellowpages.com/austin-tx/example" });
    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, { name: "pagesdata", version: VERSION });
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(SEARCH_TOOL, { keyword: "first", location: "Denver, Colorado" });
    await c.callTool(PLACE_TOOL, { url: "https://www.yellowpages.com/denver-co/example" });
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-xyz");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool(SEARCH_TOOL, { keyword: "plumber", location: "Austin, Texas" });
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the HASDATA_YELLOWPAGES_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new PagesdataClient({
      fetchFn: upstream.fetchFn,
      env: { HASDATA_YELLOWPAGES_MCP_URL: "https://staging.example.com/mcp?apis=yellowpages" },
    });
    await c.callTool(SEARCH_TOOL, { keyword: "plumber", location: "Austin, Texas" });
    assert.ok(
      upstream.calls.every(
        (call) => call.url === "https://staging.example.com/mcp?apis=yellowpages",
      ),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool(PLACE_TOOL, { url: "https://www.yellowpages.com/austin-tx/example" });
    assert.ok(upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"));
  });

  it("prefers an explicit url override over the env override", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: { HASDATA_YELLOWPAGES_MCP_URL: "https://env.example.com/mcp" },
      url: "https://explicit.example.com/mcp",
    });
    await c.callTool(SEARCH_TOOL, { keyword: "plumber", location: "Austin, Texas" });
    assert.ok(
      upstream.calls.every((call) => call.url === "https://explicit.example.com/mcp"),
    );
  });

  it("falls back to the pinned endpoint when the env override is blank", async () => {
    const upstream = makeUpstream();
    const c = new PagesdataClient({
      fetchFn: upstream.fetchFn,
      env: { HASDATA_YELLOWPAGES_MCP_URL: "   " },
    });
    await c.callTool(SEARCH_TOOL, { keyword: "plumber", location: "Austin, Texas" });
    assert.ok(upstream.calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
  });
});

/* ------------------------------------------------------------------ */

describe("upstream key header", () => {
  it("sends x-api-key on every request when HASDATA_API_KEY is set", async () => {
    const upstream = makeUpstream();
    const c = new PagesdataClient({
      fetchFn: upstream.fetchFn,
      env: { HASDATA_API_KEY: "hasdata-key-42" },
    });
    await c.callTool(SEARCH_TOOL, { keyword: "plumber", location: "Austin, Texas" });
    assert.equal(upstream.calls.length, 3);
    assert.ok(
      upstream.calls.every((call) => call.headers["x-api-key"] === "hasdata-key-42"),
    );
  });

  it("sends no x-api-key header when HASDATA_API_KEY is unset", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(SEARCH_TOOL, { keyword: "plumber", location: "Austin, Texas" });
    assert.ok(calls.every((call) => call.headers["x-api-key"] === undefined));
  });

  it("never sends an Authorization header, with or without a key", async () => {
    const withKey = makeUpstream();
    const c1 = new PagesdataClient({
      fetchFn: withKey.fetchFn,
      env: { HASDATA_API_KEY: "hasdata-key-42" },
    });
    await c1.callTool(SEARCH_TOOL, { keyword: "plumber", location: "Austin, Texas" });
    assert.ok(withKey.calls.every((call) => call.headers["Authorization"] === undefined));
    const { client: c2, calls } = stubClient();
    await c2.callTool(SEARCH_TOOL, { keyword: "plumber", location: "Austin, Texas" });
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards a place-details call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { url: "https://www.yellowpages.com/austin-tx/acme-plumbing" };
    await c.callTool(PLACE_TOOL, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, PLACE_TOOL);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a fully-specified search verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = {
      keyword: "plumber",
      location: "Austin, Texas",
      sort: "averageRating",
      domain: "www.yellowpages.ca",
      page: 2,
    };
    await c.callTool(SEARCH_TOOL, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, SEARCH_TOOL);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a minimal search verbatim", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(SEARCH_TOOL, { keyword: "minimal", location: "Remote" });
    const params = calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, { keyword: "minimal", location: "Remote" });
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool(SEARCH_TOOL, { keyword: "plumber", location: "Austin, Texas" });
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "no businesses found" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool(PLACE_TOOL, { url: "https://www.yellowpages.com/austin-tx/gone" });
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool(SEARCH_TOOL, { keyword: "plumber", location: "Austin, Texas" });
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      PLACE_TOOL,
      { url: "https://www.yellowpages.com/austin-tx/example" },
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, PLACE_TOOL);
    assert.deepEqual(params.arguments, {
      url: "https://www.yellowpages.com/austin-tx/example",
    });
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as pagesdata error text", () => {
  it("maps a JSON-RPC error to `pagesdata error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "search failed upstream" },
    });
    const out = await c.callTool(SEARCH_TOOL, { keyword: "plumber", location: "Austin, Texas" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "pagesdata error: search failed upstream");
  });

  it("maps an initialize JSON-RPC error to pagesdata error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool(SEARCH_TOOL, { keyword: "plumber", location: "Austin, Texas" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "pagesdata error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool(SEARCH_TOOL, { keyword: "plumber", location: "Austin, Texas" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "pagesdata error: malformed response");
  });

  it("maps a response with no result object to a malformed-response error", async () => {
    const { client: c } = stubClient({
      callBodyText: '{"jsonrpc":"2.0","id":3,"result":null}',
    });
    const out = await c.callTool(SEARCH_TOOL, { keyword: "plumber", location: "Austin, Texas" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "pagesdata error: malformed response");
  });

  it("maps a non-2xx upstream status to pagesdata error text", async () => {
    const { client: c } = stubClient({ callBodyText: "internal error", callStatus: 500 });
    const out = await c.callTool(SEARCH_TOOL, { keyword: "plumber", location: "Austin, Texas" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "pagesdata error: HTTP 500");
  });

  it("maps a throwing fetch to pagesdata error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool(SEARCH_TOOL, { keyword: "plumber", location: "Austin, Texas" });
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^pagesdata error: /);
  });

  it("maps a throwing initialize fetch to pagesdata error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool(SEARCH_TOOL, { keyword: "plumber", location: "Austin, Texas" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "pagesdata error: socket hang up");
  });

  it("maps a timed-out call to pagesdata error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool(SEARCH_TOOL, { keyword: "plumber", location: "Austin, Texas" });
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^pagesdata error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("picks the matching id among several SSE messages", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { n: 2 },
    });
  });

  it("ignores the SSE [DONE] sentinel", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\ndata: [DONE]\n';
    assert.deepEqual(parseRpcBody(body, 4), {
      jsonrpc: "2.0",
      id: 4,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
    assert.equal(parseRpcBody("[1,2,3]"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool with MethodNotFound before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects array arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, SEARCH_TOOL, ["nope"]),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects string arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, PLACE_TOOL, "url=https://example.com"),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid search call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, SEARCH_TOOL, { keyword: "plumber", location: "Austin, Texas" });
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, { keyword: "plumber", location: "Austin, Texas" });
  });

  it("forwards a valid place-details call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, PLACE_TOOL, { url: "https://www.yellowpages.com/austin-tx/example" });
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, PLACE_TOOL);
  });

  it("treats omitted arguments as an empty object", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, SEARCH_TOOL, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, {});
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
  }

  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
    assert.equal(res.stdout.trim(), VERSION);
  });

  it("-v prints 0.1.0 and exits 0", () => {
    const res = runCli(["-v"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([PLACE_TOOL, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli([SEARCH_TOOL, "[]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
  });
});
