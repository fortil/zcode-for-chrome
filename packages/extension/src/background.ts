import { dispatch } from "./dispatch.js";
import type { OffscreenToSw, PopupQuery } from "./messages.js";
import { setSettings } from "./settings.js";

const OFFSCREEN_URL = "offscreen.html";

async function ensureOffscreen(): Promise<void> {
  try {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      // No existe razón "WebSocket": WORKERS es la más cercana y Chrome no
      // valida el uso real de la razón (D2).
      reasons: ["WORKERS"],
      justification: "Keep a persistent WebSocket to the local ZCode MCP server",
    });
  } catch (err) {
    console.error("no se pudo crear el offscreen document", err);
  }
}

void ensureOffscreen();
chrome.runtime.onInstalled.addListener(() => void ensureOffscreen());
chrome.runtime.onStartup.addListener(() => void ensureOffscreen());

interface StoredWsState {
  wsState: "probing" | "connected" | "disconnected";
  wsPort: number;
}

async function readWsState(): Promise<StoredWsState> {
  // storage.session sobrevive a las muertes del service worker y se limpia
  // al cerrar el navegador, que es justo la vida del estado del WS.
  return (await chrome.storage.session.get({ wsState: "disconnected", wsPort: 0 })) as StoredWsState;
}

async function getStatusForPopup(): Promise<unknown> {
  const ws = await readWsState();
  return {
    wsState: ws.wsState,
    port: ws.wsPort || null,
    extensionVersion: chrome.runtime.getManifest().version,
    chromeVersion: navigator.userAgent,
  };
}

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  const m = msg as OffscreenToSw | PopupQuery;
  if (m?.kind === "bridge_request") {
    void dispatch(m.req).then(sendResponse);
    return true; // la respuesta llega async desde dispatch
  }
  if (m?.kind === "ws_state") {
    void chrome.storage.session.set({ wsState: m.state, wsPort: m.port ?? 0 });
    return false;
  }
  if (m?.kind === "get_status") {
    void getStatusForPopup().then(sendResponse);
    return true;
  }
  if (m?.kind === "set_settings") {
    void setSettings(m.patch).then(
      () => sendResponse({ ok: true }),
      (err: unknown) => sendResponse({ ok: false, error: String(err) }),
    );
    return true;
  }
  return false;
});
