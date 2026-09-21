type Level = "info" | "warn" | "error";

// Único canal de log del servidor: stderr. stdout lo usa el transporte
// JSON-RPC de MCP y cualquier línea extra rompe el framing.
export function log(level: Level, msg: string, meta?: Record<string, unknown>): void {
  const line = { ts: new Date().toISOString(), level, msg, ...meta };
  process.stderr.write(JSON.stringify(line) + "\n");
}
