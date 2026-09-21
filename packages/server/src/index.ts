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

  const port = await bridge.start();
  log("info", "server ready", { port, version: SERVER_VERSION });

  const transport = new StdioServerTransport();
  transport.onclose = () => shutdown("transport closed");
  await server.connect(transport);
}

main().catch((err) => {
  log("error", "fatal", { err: String(err) });
  process.exit(1);
});
