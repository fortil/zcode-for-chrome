import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ToolName } from "@zcode-for-chrome/shared";
import type { Bridge } from "./bridge.js";
import { SERVER_NAME, SERVER_VERSION } from "./bridge.js";
import { log } from "./log.js";
import { registerTools } from "./tools.js";

export const MCP_PATH = "/mcp";
// Short enough to guess is as good as no token: the endpoint has no rate limit.
export const MIN_TOKEN_LENGTH = 16;
// A tool call is a few hundred bytes; fill and type_text carry the largest values.
const MAX_BODY_BYTES = 1024 * 1024;
const UNAUTHORIZED_LOG_INTERVAL_MS = 60_000;

export interface HttpOptions {
  port: number;
  host: string;
  token: string;
  /** Tools to expose; undefined exposes all of them. */
  tools?: ReadonlySet<ToolName>;
}

/** Port from ZCODE_CHROME_HTTP_PORT, or undefined when the variable is unset. */
export function parseHttpPort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`ZCODE_CHROME_HTTP_PORT is not a port number: ${raw}`);
  }
  return port;
}

// Both sides are hashed first so timingSafeEqual gets inputs of equal length
// and the comparison says nothing about the token's length.
export function bearerMatches(header: string | undefined, token: string): boolean {
  // The scheme name is case-insensitive (RFC 7235).
  const match = /^Bearer +(.+)$/i.exec(header ?? "");
  if (!match) return false;
  const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(match[1]), digest(token));
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function rpcError(message: string): unknown {
  return { jsonrpc: "2.0", error: { code: -32000, message }, id: null };
}

// Unauthorized requests are counted and logged at most once a minute, so a
// scanner cannot grow the service log without bound.
let unauthorizedSinceLog = 0;
let lastUnauthorizedLog = 0;
function noteUnauthorized(): void {
  unauthorizedSinceLog += 1;
  const now = Date.now();
  if (now - lastUnauthorizedLog < UNAUTHORIZED_LOG_INTERVAL_MS) return;
  log("warn", "http unauthorized", { requests: unauthorizedSinceLog });
  unauthorizedSinceLog = 0;
  lastUnauthorizedLog = now;
}

async function handle(
  bridge: Bridge,
  opts: HttpOptions,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  // The token comes first: without it every path and method answers 401, so
  // an unauthenticated caller cannot even tell where the endpoint is.
  if (!bearerMatches(req.headers.authorization, opts.token)) {
    noteUnauthorized();
    sendJson(res, 401, rpcError("Unauthorized"), { "www-authenticate": "Bearer" });
    return;
  }
  const path = (req.url ?? "").split("?")[0];
  if (path !== MCP_PATH) {
    sendJson(res, 404, rpcError("Not found"));
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, rpcError("Method not allowed"), { allow: "POST" });
    return;
  }
  if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
    sendJson(res, 413, rpcError("Request body too large"));
    return;
  }

  // Stateless: each request gets its own MCP server and transport, all on the
  // same bridge. No session survives on this side, so a client keeps working
  // after the process restarts under a service manager.
  const mcp = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(mcp, bridge, opts.tools);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(req, res);
}

export function startHttp(bridge: Bridge, opts: HttpOptions): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    handle(bridge, opts, req, res).catch((err: unknown) => {
      log("error", "http crash", { err: String(err) });
      if (res.headersSent) res.end();
      else sendJson(res, 500, rpcError("Internal error"));
    });
  });
  // Node closes idle keep-alive sockets after 5 s by default, and a pooled
  // client that reuses one at that moment gets a reset.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      server.off("error", reject);
      // Without a listener a late error (EMFILE on accept) would be an
      // uncaught exception and take the service down.
      server.on("error", (err) => log("error", "http server error", { err: String(err) }));
      resolve(server);
    });
  });
}
