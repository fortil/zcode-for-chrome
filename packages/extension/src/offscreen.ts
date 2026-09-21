// Este documento corre en el contexto `offscreen_extension`: Chrome solo
// expone ahí chrome.runtime.{sendMessage,onMessage,connect,onConnect,getURL,
// id,lastError}. Cualquier otra API chrome.* es undefined o no-función en
// este contexto; `npm run smoke` lo comprueba sobre el bundle compilado.
import { PORT_RANGE } from "@zcode-for-chrome/shared";
import type { BridgeRequest, BridgeResponse, Hello } from "@zcode-for-chrome/shared";
import type { HelloInfo, OffscreenToSw } from "./messages.js";

const PROBE_INTERVAL_MS = 2000;
const PROBE_TIMEOUT_MS = 500;
const HELLO_ACK_TIMEOUT_MS = 5000;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

let backoffMs = MIN_BACKOFF_MS;
let socket: WebSocket | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reportState(state: "probing" | "connected" | "disconnected", port?: number): void {
  const msg: OffscreenToSw = { kind: "ws_state", state, port };
  // Este mensaje también resetea el timer de 30 s del service worker; si
  // falla (arranque, contexto cerrado) no hay nada que hacer con el error.
  void chrome.runtime.sendMessage(msg).catch(() => undefined);
}

// Sondea /health en todo el rango en paralelo y devuelve el primer puerto
// con un servidor vivo, o null si no hay ninguno.
async function findServerPort(): Promise<number | null> {
  const ports: number[] = [];
  for (let p = PORT_RANGE[0]; p <= PORT_RANGE[1]; p++) ports.push(p);
  const answers = await Promise.all(
    ports.map(async (port) => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { ok?: boolean };
        return body.ok === true ? port : null;
      } catch {
        return null;
      }
    }),
  );
  for (const port of answers) {
    if (port !== null) return port;
  }
  return null;
}

async function sendHello(ws: WebSocket): Promise<void> {
  const info = (await chrome.runtime
    .sendMessage({ kind: "get_hello" } satisfies OffscreenToSw)
    .catch(() => null)) as HelloInfo | null;
  if (!info || typeof info.extensionVersion !== "string") {
    console.warn("sin respuesta del service worker al get_hello; cierro para reintentar");
    ws.close();
    return;
  }
  const hello: Hello = {
    type: "hello",
    extensionVersion: info.extensionVersion,
    chromeVersion: navigator.userAgent,
  };
  // Sin token configurado se omite: el servidor solo lo exige si él tiene uno.
  if (typeof info.token === "string" && info.token !== "") hello.token = info.token;
  ws.send(JSON.stringify(hello));
}

// Reenvía un request al service worker y devuelve por el WS la respuesta que
// este envíe con sendResponse.
async function relay(req: BridgeRequest): Promise<void> {
  let res: BridgeResponse;
  try {
    const reply = await chrome.runtime.sendMessage({
      kind: "bridge_request",
      req,
    } satisfies OffscreenToSw);
    res =
      (reply as BridgeResponse | undefined) ??
      ({
        type: "response",
        responseTo: req.id,
        ok: false,
        error: { code: "INTERNAL", message: "el service worker no respondió" },
      } satisfies BridgeResponse);
  } catch (err) {
    res = {
      type: "response",
      responseTo: req.id,
      ok: false,
      error: { code: "INTERNAL", message: `no se pudo reenviar al service worker: ${String(err)}` },
    };
  }
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(res));
}

// Devuelve cuando el socket se cierra; wasConnected dice si llegó a saludar.
function connect(port: number): Promise<{ wasConnected: boolean }> {
  return new Promise((resolve) => {
    let wasConnected = false;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    socket = ws;
    const ackTimer = setTimeout(() => ws.close(), HELLO_ACK_TIMEOUT_MS);
    ws.onopen = () => void sendHello(ws).catch(() => ws.close());
    ws.onmessage = (ev: MessageEvent) => {
      let msg: { type?: string } | null = null;
      try {
        msg = JSON.parse(String(ev.data)) as { type?: string };
      } catch {
        return;
      }
      if (msg?.type === "hello_ack") {
        wasConnected = true;
        clearTimeout(ackTimer);
        backoffMs = MIN_BACKOFF_MS;
        reportState("connected", port);
        return;
      }
      if (msg?.type === "request") void relay(msg as unknown as BridgeRequest);
    };
    ws.onclose = () => {
      clearTimeout(ackTimer);
      if (socket === ws) socket = null;
      reportState("disconnected", port);
      resolve({ wasConnected });
    };
  });
}

async function main(): Promise<void> {
  for (;;) {
    reportState("probing");
    const port = await findServerPort();
    if (port === null) {
      // No hay servidor: reintento rápido, el sondeo es barato.
      backoffMs = MIN_BACKOFF_MS;
      await sleep(PROBE_INTERVAL_MS);
      continue;
    }
    const { wasConnected } = await connect(port);
    if (wasConnected) backoffMs = MIN_BACKOFF_MS;
    await sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }
}

void main();
