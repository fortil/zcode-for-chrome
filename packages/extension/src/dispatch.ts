import { BridgeError } from "@zcode-for-chrome/shared";
import type { BridgeErrorPayload, BridgeRequest, BridgeResponse, ToolName } from "@zcode-for-chrome/shared";
import { appendAction } from "./actionLog.js";
import { DOM_HANDLERS } from "./handlers/dom.js";
import { EVAL_HANDLERS } from "./handlers/evaluate.js";
import { INPUT_HANDLERS } from "./handlers/input.js";
import { SCREENSHOT_HANDLERS } from "./handlers/screenshot.js";
import { resolveTab, TAB_HANDLERS } from "./handlers/tabs.js";
import { checkPolicy } from "./policy.js";
import { runInTabQueue } from "./queue.js";
import { getSettings } from "./settings.js";

export type Handler = (params: Record<string, unknown>, tab?: chrome.tabs.Tab) => Promise<unknown>;

// Tools que no leen ni tocan el contenido de una pestaña: no pasan la
// política de páginas protegidas ni de hosts bloqueados.
const POLICY_EXEMPT: readonly ToolName[] = [
  "browser_status",
  "list_tabs",
  "new_tab",
  "activate_tab",
  "close_tab",
];

// Subset of POLICY_EXEMPT that still needs the resolved `tab` object (for
// tab.id): activate_tab and close_tab operate on a tab, they're only exempt
// from the protected-page/blocked-host check.
const NO_TAB: readonly ToolName[] = ["browser_status", "list_tabs", "new_tab"];

async function browserStatus(): Promise<unknown> {
  const [settings, ws] = await Promise.all([
    getSettings(),
    chrome.storage.session.get({ wsState: "disconnected", wsPort: 0 }) as Promise<{
      wsState: "probing" | "connected" | "disconnected";
      wsPort: number;
    }>,
  ]);
  return {
    enabled: settings.enabled,
    extensionVersion: chrome.runtime.getManifest().version,
    chromeVersion: navigator.userAgent,
    port: ws.wsPort || 0,
  };
}

// Las 20 tools llegan por spread desde su mapa de handlers: una clave
// explícita aquí pisaría al handler real.
export const HANDLERS: Record<ToolName, Handler> = {
  browser_status: browserStatus,
  ...TAB_HANDLERS,
  ...DOM_HANDLERS,
  ...INPUT_HANDLERS,
  ...EVAL_HANDLERS,
  ...SCREENSHOT_HANDLERS,
};

function toErrorPayload(err: unknown): BridgeErrorPayload {
  if (err instanceof BridgeError) {
    return { code: err.code, message: err.message, ...(err.hint !== undefined ? { hint: err.hint } : {}) };
  }
  return { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
}

function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export async function dispatch(req: BridgeRequest): Promise<BridgeResponse> {
  let host = "";
  let res: BridgeResponse;
  try {
    const params = req.params ?? {};
    const handler = HANDLERS[req.tool] as Handler | undefined;
    if (!handler) throw new BridgeError("INVALID_PARAMS", `tool desconocida: ${String(req.tool)}`);
    let tab: chrome.tabs.Tab | undefined;
    if (!NO_TAB.includes(req.tool)) {
      const tabId = typeof params.tabId === "number" ? params.tabId : undefined;
      tab = await resolveTab(tabId);
      host = hostOf(tab.url);
      if (!POLICY_EXEMPT.includes(req.tool)) {
        const settings = await getSettings();
        const denial = checkPolicy(tab.url ?? "", settings);
        if (denial) throw denial;
      }
    }
    // Cola por pestaña; las tools sin pestaña (browser_status, list_tabs,
    // new_tab) comparten la clave 0, que solo les cuesta el turno global.
    const result = await runInTabQueue(tab?.id ?? 0, () => handler(params, tab));
    res = { type: "response", responseTo: req.id, ok: true, result };
  } catch (err) {
    res = { type: "response", responseTo: req.id, ok: false, error: toErrorPayload(err) };
  }
  // El registro de acciones anota también los denegados por política, con su
  // code, porque son las que más interesa ver en el popup.
  void appendAction({
    ts: Date.now(),
    tool: req.tool,
    host,
    ok: res.ok,
    ...(res.ok ? {} : { code: res.error.code }),
  });
  return res;
}
