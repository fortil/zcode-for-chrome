// Smoke headless del servidor MCP: lanza el proceso real por stdio, simula la
// extensión por WebSocket y ejercita los tools con el Client del SDK.
// Sin dependencias nuevas: usa `ws` y `@modelcontextprotocol/sdk` del workspace.
// También vigila que dist/offscreen.js solo use las APIs chrome.* que Chrome
// expone en el contexto de un offscreen document (checkOffscreenApiSurface).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";

const PORT = 8790; // fuera del rango 8765-8785 para no chocar con un servidor real
const TOKEN = "smoke-token";
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const EXPECTED_TOOLS = [
  "browser_status", "list_tabs", "new_tab", "activate_tab", "close_tab",
  "navigate", "wait_for", "get_page_content", "snapshot", "query_selector",
  "screenshot", "click", "click_at", "hover", "fill", "select_option",
  "type_text", "press_key", "scroll", "evaluate_js",
  "list_profiles", "select_profile",
];
const FAKE_TAB = { tabId: 1, windowId: 1, title: "Fake", url: "https://example.com/", active: true, protected: false };
const FAKE_TAB_B = { tabId: 2, windowId: 1, title: "Fake B", url: "https://b.example.com/", active: true, protected: false };

let transport = null;

function fail(msg) {
  console.error(`SMOKE FAIL: ${msg}`);
  try { transport?._process?.kill("SIGKILL"); } catch { /* best effort */ }
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function wsOpen(origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { origin });
    const cleanup = () => {
      ws.removeAllListeners("open");
      ws.removeAllListeners("error");
      ws.removeAllListeners("unexpected-response");
    };
    ws.on("open", () => { cleanup(); resolve(ws); });
    // El servidor responde 403 crudo y destruye el socket: llega como
    // unexpected-response (403) o como error de conexión. Ambos rechazan.
    ws.on("unexpected-response", (_req, res) => {
      cleanup();
      const err = new Error(`handshake rechazado con ${res.statusCode}`);
      err.statusCode = res.statusCode;
      reject(err);
    });
    ws.on("error", (err) => { cleanup(); reject(err); });
  });
}

function textOf(result) {
  const block = result.content?.find((c) => c.type === "text");
  if (!block) fail(`respuesta sin bloque de texto: ${JSON.stringify(result)}`);
  return JSON.parse(block.text);
}

// Opens a fake extension socket, performs the hello handshake and wires a
// minimal request handler. `label` identifies the simulated Chrome profile;
// list_tabs answers with a per-label tab so routing assertions can tell the
// profiles apart.
async function connectFake(label, respond) {
  const ws = await wsOpen("chrome-extension://smokefake");
  const ack = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no llegó hello_ack en 5 s")), 5000);
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data));
      if (msg.type === "hello_ack") { clearTimeout(timer); resolve(msg); }
    });
    ws.on("close", (code) => reject(new Error(`cerrado antes de hello_ack (${code})`)));
    ws.send(JSON.stringify({ type: "hello", token: TOKEN, extensionVersion: "0.1.0-smoke", chromeVersion: "153.0.0.0", profileLabel: label }));
  });
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data));
    if (msg.type !== "request") return;
    const respondMsg = (payload) => ws.send(JSON.stringify({ type: "response", responseTo: msg.id, ...payload }));
    switch (msg.tool) {
      case "browser_status":
        respondMsg({ ok: true, result: { enabled: true } });
        break;
      case "list_tabs":
        respondMsg({ ok: true, result: [label === "profile-b" ? FAKE_TAB_B : FAKE_TAB] });
        break;
      case "screenshot":
        respondMsg({ ok: true, result: { dataUrl: `data:image/png;base64,${PNG_1X1}`, width: 1, height: 1 } });
        break;
      case "click":
        respondMsg({ ok: false, error: { code: "ELEMENT_NOT_FOUND", message: "x" } });
        break;
      case "wait_for":
        break; // sin respuesta: prueba el TIMEOUT del servidor
      default:
        respond(respondMsg);
    }
  });
  return { ws, ack };
}

// APIs chrome.* que Chromium expone en el contexto offscreen_extension, según
// extensions/common/api/_api_features.json: la mensajería de runtime y poco
// más. Si Chrome amplía la lista, hay que ampliar este Set con esa evidencia.
const OFFSCREEN_ALLOWED_APIS = new Set([
  "runtime.sendMessage",
  "runtime.onMessage",
  "runtime.connect",
  "runtime.onConnect",
  "runtime.getURL",
  "runtime.id",
  "runtime.lastError",
]);

// Red de seguridad estática sobre el bundle (el riesgo real es transitivo:
// importar settings.ts desde offscreen.ts metería chrome.storage sin que tsc
// proteste). No captura accesos indirectos tipo `const r = chrome.runtime`.
function checkOffscreenApiSurface() {
  let code;
  try {
    code = readFileSync("packages/extension/dist/offscreen.js", "utf8");
  } catch {
    fail("falta packages/extension/dist/offscreen.js: ejecuta npm run build");
  }
  const re = /\bchrome\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const api = m[1].split(".").slice(0, 2).join(".");
    if (!OFFSCREEN_ALLOWED_APIS.has(api)) {
      fail(`offscreen.js usa chrome.${api}, que Chrome no expone en offscreen documents`);
    }
  }
}

async function main() {
  checkOffscreenApiSurface();
  if (process.argv.includes("--live")) {
    return live();
  }

  // (1) lanzar el servidor real con token y puerto fijos
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ["packages/server/dist/index.js"],
    env: { ...process.env, ZCODE_CHROME_TOKEN: TOKEN, ZCODE_CHROME_PORT: String(PORT) },
  });
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(transport);

  // (2) tools/list con los 20 nombres exactos
  const { tools } = await client.listTools();
  if (tools.length !== 22) fail(`tools/list devolvió ${tools.length} tools, esperaba 22`);
  const names = new Set(tools.map((t) => t.name));
  for (const expected of EXPECTED_TOOLS) {
    if (!names.has(expected)) fail(`falta la tool "${expected}"`);
  }

  // (3) browser_status sin extensión
  let status = textOf(await client.callTool({ name: "browser_status", arguments: {} }));
  if (status.extensionConnected !== false) {
    fail(`sin extensión, extensionConnected debería ser false: ${JSON.stringify(status)}`);
  }

  // (4) hello con token malo → close 4001
  const wsBad = await wsOpen("chrome-extension://smokefake");
  const badCode = await new Promise((resolve) => {
    wsBad.on("close", (code) => resolve(code));
    wsBad.send(JSON.stringify({ type: "hello", token: "bad", extensionVersion: "0", chromeVersion: "0" }));
  });
  if (badCode !== 4001) fail(`con token malo esperaba close 4001, llegó ${badCode}`);

  // (5) upgrade con Origin web → rechazado (403 o conexión cerrada)
  try {
    await wsOpen("https://evil.example");
    fail("el handshake con Origin https://evil.example fue aceptado");
  } catch (err) {
    if (err.statusCode !== undefined && err.statusCode !== 403) {
      fail(`con Origin web esperaba 403, llegó ${err.statusCode}`);
    }
  }

  // (6) extensión falsa correcta: hello válido + responder a los requests
  const { ws, ack } = await connectFake("personal", (respond) =>
    respond({ ok: false, error: { code: "INTERNAL", message: "no implementado en la fake" } }),
  );
  if (ack.type !== "hello_ack" || typeof ack.connectionId !== "string" || ack.connectionId.length < 8) {
    fail(`hello_ack sin connectionId: ${JSON.stringify(ack)}`);
  }

  // (7) asserts de extremo a extremo
  status = textOf(await client.callTool({ name: "browser_status", arguments: {} }));
  if (status.extensionConnected !== true) {
    fail(`con la fake conectada, extensionConnected debería ser true: ${JSON.stringify(status)}`);
  }

  const tabs = textOf(await client.callTool({ name: "list_tabs", arguments: {} }));
  if (!Array.isArray(tabs) || tabs.length !== 1 || tabs[0].url !== FAKE_TAB.url || tabs[0].tabId !== 1) {
    fail(`list_tabs devolvió ${JSON.stringify(tabs)}`);
  }

  const shot = await client.callTool({ name: "screenshot", arguments: {} });
  const image = shot.content?.[0];
  if (image?.type !== "image" || image.mimeType !== "image/png" || image.data !== PNG_1X1) {
    fail(`screenshot devolvió ${JSON.stringify(shot.content?.[0])}`);
  }

  const clickRes = await client.callTool({ name: "click", arguments: { selector: "#nope" } });
  if (clickRes.isError !== true) fail("click con error del puente debería llegar con isError:true");
  const clickErr = textOf(clickRes);
  if (clickErr.code !== "ELEMENT_NOT_FOUND") fail(`click devolvió código ${clickErr.code}`);

  const t0 = Date.now();
  const waitRes = await client.callTool({ name: "wait_for", arguments: { text: "nunca-aparece", timeoutMs: 1000 } });
  const elapsed = Date.now() - t0;
  if (waitRes.isError !== true) fail("wait_for sin respuesta debería llegar con isError:true");
  const waitErr = textOf(waitRes);
  if (waitErr.code !== "TIMEOUT") fail(`wait_for devolvió código ${waitErr.code}`);
  if (elapsed >= 8000) fail(`wait_for con timeoutMs 1000 tardó ${elapsed} ms`);

  // (7b) segundo perfil falso: registro, ambigüedad y enrutado por etiqueta
  const { ws: wsB } = await connectFake("profile-b", (respond) =>
    respond({ ok: false, error: { code: "INTERNAL", message: "no implementado en la fake" } }),
  );

  let profiles = textOf(await client.callTool({ name: "list_profiles", arguments: {} }));
  const labels = (profiles.profiles ?? []).map((p) => p.label).sort();
  if (labels.join(",") !== "personal,profile-b") fail(`list_profiles devolvió ${JSON.stringify(profiles)}`);
  if (profiles.selected !== null) fail(`sin selección, selected debería ser null: ${JSON.stringify(profiles)}`);

  // Dos conexiones sin selección → error de ambigüedad con hint
  const amb = await client.callTool({ name: "list_tabs", arguments: {} });
  if (amb.isError !== true) fail("list_tabs con dos perfiles y sin selección debería fallar");
  const ambErr = textOf(amb);
  if (!/multiple Chrome profiles/.test(ambErr.message)) fail(`ambigüedad inesperada: ${JSON.stringify(ambErr)}`);

  // Selección de un perfil inexistente → error que lista los conectados
  const bad = await client.callTool({ name: "select_profile", arguments: { profile: "nope" } });
  if (bad.isError !== true) fail("select_profile con etiqueta inexistente debería fallar");
  if (!/profile-b/.test(String(textOf(bad).hint ?? ""))) fail(`el hint debería listar perfiles: ${JSON.stringify(textOf(bad))}`);

  // select_profile enruta las tools a la conexión elegida
  const sel = textOf(await client.callTool({ name: "select_profile", arguments: { profile: "profile-b" } }));
  if (sel.ok !== true || sel.selected !== "profile-b") fail(`select_profile devolvió ${JSON.stringify(sel)}`);
  const tabsB = textOf(await client.callTool({ name: "list_tabs", arguments: {} }));
  if (tabsB[0]?.tabId !== FAKE_TAB_B.tabId) fail(`con profile-b, list_tabs devolvió ${JSON.stringify(tabsB)}`);

  // Reconexión con la misma etiqueta reemplaza a la anterior (no quedan dos)
  const { ws: wsB2, ack: ackB2 } = await connectFake("profile-b", (respond) =>
    respond({ ok: false, error: { code: "INTERNAL", message: "no implementado en la fake" } }),
  );
  if (ackB2.connectionId === ack.connectionId) fail("connectionIds no deberían repetirse entre conexiones");
  const replaced = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 5000);
    wsB.on("close", (code) => { clearTimeout(timer); resolve(code); });
  });
  if (replaced !== 4000) fail(`la conexión reemplazada debería cerrar con 4000, llegó ${replaced}`);
  const tabsB2 = textOf(await client.callTool({ name: "list_tabs", arguments: {} }));
  if (tabsB2[0]?.tabId !== FAKE_TAB_B.tabId) fail(`tras reemplazo, list_tabs devolvió ${JSON.stringify(tabsB2)}`);
  profiles = textOf(await client.callTool({ name: "list_profiles", arguments: {} }));
  if ((profiles.profiles ?? []).filter((p) => p.label === "profile-b").length !== 1) {
    fail(`debería quedar una sola conexión profile-b: ${JSON.stringify(profiles)}`);
  }

  // "default" restaura el modo automático (no hay ningún perfil llamado
  // "default" conectado): con dos conexiones vuelve la ambigüedad, y al
  // quedar una sola se enruta sin selección.
  const auto = textOf(await client.callTool({ name: "select_profile", arguments: { profile: "default" } }));
  if (auto.ok !== true || auto.selected !== null) fail(`select_profile default devolvió ${JSON.stringify(auto)}`);
  wsB2.close();
  const tabsA = textOf(await client.callTool({ name: "list_tabs", arguments: {} }));
  if (tabsA[0]?.tabId !== FAKE_TAB.tabId) fail(`con una sola conexión, list_tabs devolvió ${JSON.stringify(tabsA)}`);

  // (8) el proceso hijo muere solo al cerrar stdin, en ≤3 s
  const pid = transport._process?.pid;
  ws.close();
  await client.close();
  if (!pid) fail("no pude obtener el pid del servidor");
  let dead = false;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { dead = true; break; }
    await sleep(100);
  }
  if (!dead) fail("el proceso servidor seguía vivo 3 s después de cerrar stdin");

  console.log("SMOKE OK");
  process.exit(0);
}

// Smoke live (Paso 14): mismo servidor real, pero la extensión es la de verdad,
// cargada como descomprimida en el Chrome del usuario. Sin token y sin puerto
// fijo: la extensión encuentra el servidor sondeando /health por el rango
// 8765-8785. Recorre el flujo E2E de ejemplo.com de punta a punta: navegación,
// lectura, snapshot con refs, click por ref, historial, captura, CDP y cierre.
async function live() {
  const env = { ...process.env };
  // El live arranca el servidor en modo confiado (sin token) y con puerto
  // libre del rango: si el entorno trajera alguna de estas variables, la
  // extensión no podría conectarse.
  delete env.ZCODE_CHROME_TOKEN;
  delete env.ZCODE_CHROME_PORT;
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ["packages/server/dist/index.js"],
    env,
  });
  const client = new Client({ name: "smoke-live", version: "0.0.0" });
  await client.connect(transport);

  console.error("Carga la extensión desempaquetada y espera (hasta 60 s)...");
  const deadline = Date.now() + 60000;
  let status = null;
  while (Date.now() < deadline) {
    status = textOf(await client.callTool({ name: "browser_status", arguments: {} }));
    if (status.extensionConnected === true) break;
    await sleep(1000);
  }
  if (!status || status.extensionConnected !== true) {
    fail("extension not connected: carga packages/extension/dist en chrome://extensions y reintenta");
  }
  console.error(`extensión conectada en el puerto ${status.port}`);

  const tab = textOf(await client.callTool({ name: "new_tab", arguments: { url: "https://example.com/" } }));
  if (typeof tab.tabId !== "number") fail(`new_tab no devolvió tabId: ${JSON.stringify(tab)}`);
  const tabId = tab.tabId;

  const waited = textOf(await client.callTool({ name: "wait_for", arguments: { tabId, text: "Example Domain" } }));
  if (waited.matched !== "text") fail(`wait_for text devolvió ${JSON.stringify(waited)}`);

  const content = textOf(await client.callTool({ name: "get_page_content", arguments: { tabId } }));
  if (!String(content.text || "").includes("Example Domain")) {
    fail(`get_page_content no contiene "Example Domain": ${JSON.stringify(content).slice(0, 200)}`);
  }

  const snap = textOf(await client.callTool({ name: "snapshot", arguments: { tabId } }));
  const header = /^snapshot (s[0-9a-z]+) tab /.exec(snap);
  const linkLine = snap.split("\n").find((l) => /\[e\d+\] link "(More information|Learn more)/i.test(l));
  if (!header || !linkLine) fail(`snapshot sin cabecera o sin el link de example.com:\n${String(snap).slice(0, 500)}`);
  // Ref completo <snapId>e<n>: lleva el snapId embebido y se valida contra el
  // vigente en el ISOLATED world (D4).
  const ref = header[1] + /\[(e\d+)\]/.exec(linkLine)[1];
  const clicked = textOf(await client.callTool({ name: "click", arguments: { tabId, ref } }));
  if (clicked.ok !== true) fail(`click por ref devolvió ${JSON.stringify(clicked)}`);

  const iana = textOf(await client.callTool({ name: "wait_for", arguments: { tabId, urlContains: "iana.org" } }));
  if (iana.matched !== "url") fail(`wait_for urlContains devolvió ${JSON.stringify(iana)}`);

  const back = textOf(await client.callTool({ name: "navigate", arguments: { tabId, action: "back" } }));
  if (back.tabId !== tabId) fail(`navigate back devolvió ${JSON.stringify(back)}`);
  if (!String(back.url || "").includes("example.com")) fail(`navigate back did not return to example.com: ${JSON.stringify(back)}`);

  const forward = textOf(await client.callTool({ name: "navigate", arguments: { tabId, action: "forward" } }));
  if (forward.tabId !== tabId) fail(`navigate forward devolvió ${JSON.stringify(forward)}`);
  if (!String(forward.url || "").includes("iana.org")) fail(`navigate forward did not return to iana.org: ${JSON.stringify(forward)}`);

  const shot = await client.callTool({ name: "screenshot", arguments: { tabId } });
  if (shot.content?.[0]?.type !== "image" || !shot.content[0].data) {
    fail(`screenshot no devolvió imagen: ${JSON.stringify(shot.content?.[0]?.type)}`);
  }

  const evaluated = textOf(await client.callTool({ name: "evaluate_js", arguments: { tabId, expression: "1+1" } }));
  if (JSON.parse(evaluated.value) !== 2) fail(`evaluate_js 1+1 devolvió ${JSON.stringify(evaluated)}`);

  const key = textOf(await client.callTool({ name: "press_key", arguments: { tabId, key: "End" } }));
  if (key.ok !== true) fail(`press_key End devolvió ${JSON.stringify(key)}`);

  const closed = textOf(await client.callTool({ name: "close_tab", arguments: { tabId } }));
  if (closed.ok !== true) fail(`close_tab devolvió ${JSON.stringify(closed)}`);

  await client.close();
  console.log("LIVE OK");
  process.exit(0);
}

main().catch((err) => fail(err?.stack ?? String(err)));
