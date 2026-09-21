import { dispatch } from "./dispatch.js";
import type { HelloInfo, OffscreenToSw, PopupQuery } from "./messages.js";
import { getSettings, setSettings } from "./settings.js";

const OFFSCREEN_URL = "offscreen.html";

// void ensureOffscreen() se dispara a la vez desde el top-level del módulo y
// desde onInstalled/onStartup: sin este lock, dos llamadas concurrentes ven
// hasDocument()===false a la vez y la segunda createDocument() revienta con
// "Only a single offscreen document may be created."
let ensureOffscreenInFlight: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  if (ensureOffscreenInFlight) return ensureOffscreenInFlight;
  ensureOffscreenInFlight = (async () => {
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
    } finally {
      ensureOffscreenInFlight = null;
    }
  })();
  return ensureOffscreenInFlight;
}

void ensureOffscreen();
chrome.runtime.onInstalled.addListener(() => void ensureOffscreen());
chrome.runtime.onStartup.addListener(() => void ensureOffscreen());

// The offscreen document owns the WebSocket, but nothing above restarts it if
// Chrome reclaims it while the service worker is asleep (its own death wakes
// nobody). A periodic alarm wakes the worker, and its top-level
// ensureOffscreen() recreates the document if it is gone.
const REVIVE_ALARM = "ensure-offscreen";
chrome.alarms.create(REVIVE_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REVIVE_ALARM) void ensureOffscreen();
});

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
  if (m?.kind === "get_hello") {
    // El offscreen document solo tiene chrome.runtime de mensajería: ni
    // chrome.storage ni chrome.runtime.getManifest están expuestos ahí por
    // diseño de Chrome (extensions/common/api/_api_features.json). Lo que el
    // hello necesita de ahí se responde desde aquí.
    void getSettings().then((s) =>
      sendResponse({ token: s.token, extensionVersion: chrome.runtime.getManifest().version } satisfies HelloInfo),
    );
    return true;
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
