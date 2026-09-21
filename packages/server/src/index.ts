import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PORT_RANGE } from "@zcode-for-chrome/shared";
import { Bridge, SERVER_NAME, SERVER_VERSION } from "./bridge.js";
import { registerTools } from "./tools.js";
import { log } from "./log.js";

async function main(): Promise<void> {
  const bridge = new Bridge({
    portRange: PORT_RANGE,
    fixedPort: Number(process.env.ZCODE_CHROME_PORT) || undefined,
    token: process.env.ZCODE_CHROME_TOKEN,
    allowedOrigin: process.env.ZCODE_CHROME_ALLOWED_ORIGIN,
    allowScan: process.env.ZCODE_CHROME_ALLOW_SCAN === "1",
  });
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, bridge);

  // Watchdog: sin stdin no hay cliente MCP, el proceso no tiene razón de vivir.
  let exiting = false;
  const shutdown = (reason: string): void => {
    if (exiting) return;
    exiting = true;
    log("info", "shutting down", { reason });
    void bridge.stop().finally(() => process.exit(0));
  };
  process.stdin.on("end", () => shutdown("stdin end"));
  process.stdin.on("close", () => shutdown("stdin close"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const transport = new StdioServerTransport();
  transport.onclose = () => shutdown("transport closed");
  // MCP handshake first: if the bridge port is taken by another live session,
  // exclusive mode makes start() wait for it, and that must not look like a
  // dead MCP server. Tool calls while waiting fail with a hint that names the
  // port holder.
  await server.connect(transport);

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
