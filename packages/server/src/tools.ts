import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BridgeError, LIMITS, TOOL_TIMEOUTS_MS } from "@zcode-for-chrome/shared";
import type { ToolName } from "@zcode-for-chrome/shared";
import type { Bridge } from "./bridge.js";
import { SERVER_VERSION } from "./bridge.js";
import { parseParams, TOOL_SHAPES } from "./schemas.js";
import { log } from "./log.js";

const DEFAULT_WAIT_MS = 10000;
const WAIT_GRACE_MS = 5000;

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  browser_status: "Estado del puente: extensión conectada, puerto, versiones y enabled",
  list_tabs: "Lista las pestañas abiertas con su URL y título",
  new_tab: "Abre una pestaña nueva (opcionalmente con URL) y espera a que termine de cargar",
  activate_tab: "Activa (enfoca) una pestaña por su tabId",
  close_tab: "Cierra una pestaña por su tabId",
  navigate: "Navega una pestaña a una URL o ejecuta back/forward/reload",
  wait_for: "Espera a que aparezca un selector, un texto o a que la URL contenga algo",
  get_page_content: "Devuelve el texto visible de la página o del elemento dado por selector",
  snapshot: "Snapshot de la página: un ref eN por elemento interactivo, con rol y nombre accesible",
  query_selector: "Busca elementos por selector CSS y les asigna refs eN",
  screenshot: "Captura la pestaña (viewport o página completa) y la reescala a maxWidth",
  click: "Hace click en un elemento por ref o selector; trusted:true usa CDP",
  click_at: "Click trusted por coordenadas del viewport (CDP)",
  hover: "Mueve el ratón al centro de un elemento (CDP)",
  fill: "Escribe un valor en un input, textarea, contenteditable o select",
  select_option: "Selecciona una opción de un <select> por value o label",
  type_text: "Escribe texto como teclado real con CDP Input.insertText",
  press_key: "Pulsa una tecla (con modificadores opcionales) por CDP",
  scroll: "Desplaza la página en una dirección o lleva un elemento al centro",
  evaluate_js: "Evalúa una expresión JS en la página vía Runtime.evaluate",
};

type ToolResult = CallToolResult;

function errorContent(err: BridgeError): ToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) }),
      },
    ],
  };
}

// Timeout del servidor por tool. wait_for es dinámico: el tiempo que pide el
// agente (acotado a LIMITS.maxWaitMs) más un margen para que la respuesta de
// error la genere la extensión, no el servidor.
function timeoutFor(tool: ToolName, params: Record<string, unknown>): number {
  if (tool === "wait_for") {
    const requested = typeof params.timeoutMs === "number" ? params.timeoutMs : DEFAULT_WAIT_MS;
    return Math.min(requested, LIMITS.maxWaitMs) + WAIT_GRACE_MS;
  }
  return TOOL_TIMEOUTS_MS[tool];
}

function resultContent(tool: ToolName, result: unknown): ToolResult {
  if (tool === "screenshot" && result !== null && typeof result === "object") {
    const r = result as {
      dataUrl?: unknown;
      width?: unknown;
      height?: unknown;
      tabId?: unknown;
      url?: unknown;
    };
    const match = /^data:image\/(png|jpeg);base64,(.+)$/.exec(typeof r.dataUrl === "string" ? r.dataUrl : "");
    if (match) {
      return {
        content: [
          { type: "image", data: match[2], mimeType: `image/${match[1]}` },
          {
            type: "text",
            text: JSON.stringify({ width: r.width, height: r.height, tabId: r.tabId, url: r.url }),
          },
        ],
      };
    }
  }
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

async function viaBridge(bridge: Bridge, tool: ToolName, args: unknown): Promise<ToolResult> {
  let params: Record<string, unknown>;
  try {
    params = parseParams(tool, args);
  } catch (err) {
    if (err instanceof BridgeError) return errorContent(err);
    throw err;
  }
  const started = Date.now();
  try {
    const result = await bridge.call<unknown>(tool, params, timeoutFor(tool, params));
    log("info", "tool ok", { tool, ms: Date.now() - started });
    return resultContent(tool, result);
  } catch (err) {
    if (err instanceof BridgeError) {
      log("warn", "tool error", { tool, code: err.code, ms: Date.now() - started });
      return errorContent(err);
    }
    log("error", "tool crash", { tool, err: String(err) });
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ code: "INTERNAL", message: String(err) }) }],
    };
  }
}

async function browserStatus(bridge: Bridge): Promise<ToolResult> {
  const conflict = bridge.conflictInfo();
  const base = {
    extensionConnected: bridge.isConnected(),
    port: bridge.getPort(),
    serverVersion: SERVER_VERSION,
    ...(bridge.extensionInfo() ?? {}),
    ...(conflict ? { conflict } : {}),
  };
  if (!bridge.isConnected()) {
    return { content: [{ type: "text", text: JSON.stringify(base) }] };
  }
  try {
    const result = await bridge.call<Record<string, unknown>>("browser_status", {}, TOOL_TIMEOUTS_MS.browser_status);
    const merged = { ...base, ...result, extensionConnected: true };
    return { content: [{ type: "text", text: JSON.stringify(merged) }] };
  } catch (err) {
    if (err instanceof BridgeError) return errorContent(err);
    throw err;
  }
}

export function registerTools(server: McpServer, bridge: Bridge): void {
  for (const tool of Object.keys(TOOL_DESCRIPTIONS) as ToolName[]) {
    const config = { description: TOOL_DESCRIPTIONS[tool], inputSchema: TOOL_SHAPES[tool] };
    if (tool === "browser_status") {
      server.registerTool(tool, config, () => browserStatus(bridge));
      continue;
    }
    server.registerTool(tool, config, (args: unknown) => viaBridge(bridge, tool, args));
  }
}
