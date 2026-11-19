import type http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PORT_RANGE } from "@zcode-for-chrome/shared";
import { Bridge, SERVER_NAME, SERVER_VERSION } from "./bridge.js";
import { MCP_PATH, MIN_TOKEN_LENGTH, parseHttpPort, startHttp } from "./http.js";
import { parseToolAllowlist, registerTools } from "./tools.js";
import { log } from "./log.js";

async function main(): Promise<void> {
  const tools = parseToolAllowlist(process.env.ZCODE_CHROME_TOOLS);
  const httpPort = parseHttpPort(process.env.ZCODE_CHROME_HTTP_PORT);
  const httpToken = process.env.ZCODE_CHROME_HTTP_TOKEN;
  // An HTTP endpoint that drives a real browser is never served open: any
  // process that reaches the port could use the browser's sessions.
  if (httpPort !== undefined && (!httpToken || httpToken.length < MIN_TOKEN_LENGTH)) {
    throw new Error(`ZCODE_CHROME_HTTP_PORT needs ZCODE_CHROME_HTTP_TOKEN with at least ${MIN_TOKEN_LENGTH} characters`);
  }

  const bridge = new Bridge({
    portRange: PORT_RANGE,
    fixedPort: Number(process.env.ZCODE_CHROME_PORT) || undefined,
    token: process.env.ZCODE_CHROME_TOKEN,
    allowedOrigin: process.env.ZCODE_CHROME_ALLOWED_ORIGIN,
  });

  let exiting = false;
  let httpServer: http.Server | null = null;
  const shutdown = (reason: string): void => {
    if (exiting) return;
    exiting = true;
    log("info", "shutting down", { reason });
    httpServer?.close();
    httpServer?.closeAllConnections();
    void bridge.stop().finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  if (httpPort !== undefined && httpToken) {
    // HTTP mode runs as a service: no stdin watchdog, it lives until a signal.
    const host = process.env.ZCODE_CHROME_HTTP_HOST || "127.0.0.1";
    httpServer = await startHttp(bridge, { port: httpPort, host, token: httpToken, tools });
    log("info", "http ready", { host, port: httpPort, path: MCP_PATH });
    if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
      log("warn", "http endpoint is not on loopback: the token travels in clear text", { host });
    }
  } else {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    registerTools(server, bridge, tools);

    // Watchdog: sin stdin no hay cliente MCP, el proceso no tiene razón de vivir.
    process.stdin.on("end", () => shutdown("stdin end"));
    process.stdin.on("close", () => shutdown("stdin close"));

    const transport = new StdioServerTransport();
    transport.onclose = () => shutdown("transport closed");
    // MCP handshake first: start() is fast (first free port of the range), but
    // a fixed-port env var could still make it fail, and that must not look
    // like a dead MCP server. Tool calls before the bridge is up fail with a
    // hint that names the port holder.
    await server.connect(transport);
  }

  void bridge.start().then(
    (port) => log("info", "server ready", { port, version: SERVER_VERSION }),
    (err: unknown) => {
      log("error", "fatal", { err: String(err) });
      if (!exiting) process.exit(1);
    },
  );
}

main().catch((err) => {
  log("error", "fatal", { err: String(err) });
  process.exit(1);
});
