// Este documento corre en el contexto `offscreen_extension`: Chrome solo
// expone ahí chrome.runtime.{sendMessage,onMessage,connect,onConnect,getURL,
// id,lastError}. Cualquier otra API chrome.* es undefined o no-función en
// este contexto; `npm run smoke` lo comprueba sobre el bundle compilado.
import { PORT_RANGE } from "@zcode-for-chrome/shared";
import type { BridgeRequest, BridgeResponse, Hello } from "@zcode-for-chrome/shared";
import type { HelloInfo, OffscreenToSw, SwToOffscreenCommand } from "./messages.js";

const PROBE_INTERVAL_MS = 2000;
const PROBE_TIMEOUT_MS = 500;
const HELLO_ACK_TIMEOUT_MS = 5000;
// A port whose /health answered but whose WS handshake failed gets benched
// for a while: re-picking it every round would starve the next healthy port.
const BLOCK_AFTER_FAILED_HELLO_MS = 60_000;

// One WebSocket per healthy bridge server. Every ZCode session runs its own
// server on its own port of the range, so connecting to all of them lets
// several sessions use this browser at once, each picking its profile.
const sockets = new Map<number, WebSocket>();
// Routes each in-flight request back to the socket it arrived on.
const requestRoutes = new Map<string, WebSocket>();
const blockedUntil = new Map<number, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reportState(state: "probing" | "connected" | "disconnected", port?: number): void {
  const msg: OffscreenToSw = { kind: "ws_state", state, port };
  // Este mensaje también resetea el timer de 30 s del service worker; si
  // falla (arranque, contexto cerrado) no hay nada que hacer con el error.
  void chrome.runtime.sendMessage(msg).catch(() => undefined);
}

// Sondea /health en todo el rango en paralelo y devuelve los puertos de
// servidores del puente (el /health lleva name) que no estén castigados por
// un hello fallido reciente.
async function findServerPorts(): Promise<number[]> {
  const ports: number[] = [];
  for (let p = PORT_RANGE[0]; p <= PORT_RANGE[1]; p++) ports.push(p);
  const answers = await Promise.all(
    ports.map(async (port) => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { ok?: boolean; name?: string };
        return body.ok === true && body.name === "zcode-for-chrome" ? port : null;
      } catch {
        return null;
      }
    }),
  );
  const healthy = answers.filter((port): port is number => port !== null);
  const now = Date.now();
  return healthy.filter((port) => (blockedUntil.get(port) ?? 0) <= now);
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
    profileLabel: info.profileLabel,
  };
  // Sin token configurado se omite: el servidor solo lo exige si él tiene uno.
  if (typeof info.token === "string" && info.token !== "") hello.token = info.token;
  ws.send(JSON.stringify(hello));
}

// Reenvía un request al service worker y devuelve por el WS de origen la
// respuesta que este envíe con sendResponse.
async function relay(req: BridgeRequest, ws: WebSocket): Promise<void> {
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
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(res));
}

// Abre el socket a un servidor y lo deja gestionándose solo: el supervisor lo
// detecta vía sockets map, y un hello sin ack castiga el puerto por un rato.
function connect(port: number): void {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.set(port, ws);
  let helloAcked = false;
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
      helloAcked = true;
      clearTimeout(ackTimer);
      reportState("connected", port);
      return;
    }
    if (msg?.type === "request") {
      const req = msg as unknown as BridgeRequest;
      requestRoutes.set(req.id, ws);
      void relay(req, ws);
    }
  };
  ws.onclose = () => {
    clearTimeout(ackTimer);
    if (sockets.get(port) === ws) sockets.delete(port);
    for (const [id, route] of requestRoutes) {
      if (route === ws) requestRoutes.delete(id);
    }
    if (helloAcked) {
      reportState("disconnected", port);
    } else {
      // El /health respondió pero el WS no completó el saludo: servidor
      // ajeno o roto. Lo apartamos un rato para no reintentar en bucle.
      blockedUntil.set(port, Date.now() + BLOCK_AFTER_FAILED_HELLO_MS);
    }
  };
}

async function main(): Promise<void> {
  for (;;) {
    if (sockets.size === 0) reportState("probing");
    const healthy = await findServerPorts();
    // Only dial new ports here; live sockets are never torn down for a missed
    // probe (the server side closes them itself when it goes away).
    for (const port of healthy) {
      if (!sockets.has(port)) connect(port);
    }
    await sleep(PROBE_INTERVAL_MS);
  }
}

// The service worker asks for a full reconnect when the profile label (or
// another hello-relevant setting) changes: close everything and let the loop
// dial again with fresh hello data.
chrome.runtime.onMessage.addListener((msg: unknown) => {
  const m = msg as SwToOffscreenCommand | null;
  if (m?.kind === "reconnect") {
    blockedUntil.clear();
    for (const ws of sockets.values()) ws.close();
  }
  return false;
});

void main();
