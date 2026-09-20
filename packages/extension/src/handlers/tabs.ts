import { BridgeError, LIMITS } from "@zcode-for-chrome/shared";
import type { ToolName } from "@zcode-for-chrome/shared";
import { isProtectedUrl } from "../policy.js";

export type TabHandler = (params: Record<string, unknown>, tab?: chrome.tabs.Tab) => Promise<unknown>;

export type TabToolName = Extract<
  ToolName,
  "list_tabs" | "new_tab" | "activate_tab" | "close_tab" | "navigate" | "wait_for"
>;

// Por debajo del timeout de 45 s que aplica el servidor a new_tab y navigate:
// si la pestaña cuelga, el error TIMEOUT lo genera la extensión.
const COMPLETE_TIMEOUT_MS = 40000;
const WAIT_POLL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function resolveTab(tabId?: number): Promise<chrome.tabs.Tab> {
  let tab: chrome.tabs.Tab | undefined;
  try {
    if (tabId !== undefined) {
      tab = await chrome.tabs.get(tabId);
    } else {
      [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    }
  } catch (err) {
    throw new BridgeError("TAB_NOT_FOUND", `no se encontró la pestaña: ${String(err)}`);
  }
  if (!tab || tab.id === undefined) {
    throw new BridgeError("TAB_NOT_FOUND", "la pestaña no existe o no tiene id");
  }
  return tab;
}

export function waitForComplete(tabId: number, timeoutMs: number): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    let done = false;
    // El listener se registra antes de consultar el estado actual para no
    // perderse el evento "complete" si llega entre la consulta y el alta.
    const listener = (updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab): void => {
      if (updatedTabId === tabId && changeInfo.status === "complete" && !done) {
        cleanup();
        resolve(tab);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new BridgeError("TIMEOUT", `la pestaña ${tabId} no terminó de cargar en ${timeoutMs} ms`));
    }, timeoutMs);
    function cleanup(): void {
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    }
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs
      .get(tabId)
      .then((current) => {
        if (!done && current.status === "complete") {
          cleanup();
          resolve(current);
        }
      })
      .catch((err: unknown) => {
        if (!done) {
          cleanup();
          reject(new BridgeError("TAB_NOT_FOUND", `no se encontró la pestaña: ${String(err)}`));
        }
      });
  });
}

// Función autocontenida: se inyecta con executeScript, que la serializa con
// toString(), así que no puede referenciar nada fuera de su propio cuerpo.
function waitProbe(arg: { selector?: string; text?: string }): { selector: boolean; text: boolean } {
  return {
    selector: arg.selector !== undefined ? document.querySelector(arg.selector) !== null : false,
    text: arg.text !== undefined && document.body ? document.body.innerText.includes(arg.text) : false,
  };
}

async function execWaitProbe(tabId: number, arg: { selector?: string; text?: string }): Promise<{ selector: boolean; text: boolean }> {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      func: waitProbe,
      args: [arg],
    });
  } catch (err) {
    // Carrera habitual: la pestaña está navegando y el frame no es accesible
    // un instante. Si la URL es de verdad inaccesible, la política ya la
    // habría cortado antes.
    if (String(err).includes("Cannot access contents of the page")) {
      return { selector: false, text: false };
    }
    throw err;
  }
  return (results[0]?.result as { selector: boolean; text: boolean }) ?? { selector: false, text: false };
}

async function listTabs(): Promise<unknown> {
  const tabs = await chrome.tabs.query({});
  return tabs.map((tab) => ({
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? "",
    url: tab.url ?? "",
    active: tab.active,
    protected: tab.url ? isProtectedUrl(tab.url) : true,
  }));
}

async function newTab(params: Record<string, unknown>): Promise<unknown> {
  const url = typeof params.url === "string" && params.url !== "" ? params.url : undefined;
  const active = params.active !== false;
  const tab = await chrome.tabs.create({ url, active });
  if (tab.id === undefined) throw new BridgeError("INTERNAL", "la pestaña creada no tiene id");
  const complete = await waitForComplete(tab.id, COMPLETE_TIMEOUT_MS);
  return { tabId: tab.id, url: complete.url ?? url ?? "" };
}

async function activateTab(_params: Record<string, unknown>, tab?: chrome.tabs.Tab): Promise<unknown> {
  if (!tab || tab.id === undefined) throw new BridgeError("INVALID_PARAMS", "activate_tab requiere tabId");
  try {
    await chrome.tabs.update(tab.id, { active: true });
  } catch (err) {
    throw new BridgeError("TAB_NOT_FOUND", `no se pudo activar la pestaña: ${String(err)}`);
  }
  return { ok: true };
}

async function closeTab(_params: Record<string, unknown>, tab?: chrome.tabs.Tab): Promise<unknown> {
  if (!tab || tab.id === undefined) throw new BridgeError("INVALID_PARAMS", "close_tab requiere tabId");
  try {
    await chrome.tabs.remove(tab.id);
  } catch (err) {
    throw new BridgeError("TAB_NOT_FOUND", `no se pudo cerrar la pestaña: ${String(err)}`);
  }
  return { ok: true };
}

async function navigate(params: Record<string, unknown>, tab?: chrome.tabs.Tab): Promise<unknown> {
  if (!tab || tab.id === undefined) throw new BridgeError("TAB_NOT_FOUND", "navigate no tiene pestaña destino");
  const { url, action } = params as { url?: unknown; action?: unknown };
  if (typeof url === "string" && url !== "") {
    await chrome.tabs.update(tab.id, { url });
  } else if (action === "back" || action === "forward" || action === "reload") {
    if (action === "back") await chrome.tabs.goBack(tab.id);
    else if (action === "forward") await chrome.tabs.goForward(tab.id);
    else await chrome.tabs.reload(tab.id);
  } else {
    throw new BridgeError("INVALID_PARAMS", "navigate necesita exactamente url o action (back|forward|reload)");
  }
  const complete = await waitForComplete(tab.id, COMPLETE_TIMEOUT_MS);
  return { tabId: tab.id, url: complete.url ?? "", title: complete.title ?? "" };
}

async function waitFor(params: Record<string, unknown>, tab?: chrome.tabs.Tab): Promise<unknown> {
  if (!tab || tab.id === undefined) throw new BridgeError("TAB_NOT_FOUND", "wait_for no tiene pestaña destino");
  const selector = typeof params.selector === "string" ? params.selector : undefined;
  const text = typeof params.text === "string" ? params.text : undefined;
  const urlContains = typeof params.urlContains === "string" ? params.urlContains : undefined;
  if (selector === undefined && text === undefined && urlContains === undefined) {
    throw new BridgeError("INVALID_PARAMS", "wait_for necesita selector, text o urlContains");
  }
  const requested = typeof params.timeoutMs === "number" ? params.timeoutMs : 10000;
  const timeoutMs = Math.min(Math.max(requested, 1), LIMITS.maxWaitMs);
  const started = Date.now();
  for (;;) {
    if (urlContains !== undefined) {
      const current = await chrome.tabs.get(tab.id);
      if ((current.url ?? "").includes(urlContains)) {
        return { matched: "url", elapsedMs: Date.now() - started };
      }
    }
    if (selector !== undefined || text !== undefined) {
      const probe = await execWaitProbe(tab.id, { selector, text });
      if (selector !== undefined && probe.selector) {
        return { matched: "selector", elapsedMs: Date.now() - started };
      }
      if (text !== undefined && probe.text) {
        return { matched: "text", elapsedMs: Date.now() - started };
      }
    }
    if (Date.now() - started >= timeoutMs) {
      throw new BridgeError("TIMEOUT", `wait_for no encontró nada en ${timeoutMs} ms`);
    }
    await sleep(WAIT_POLL_MS);
  }
}

export const TAB_HANDLERS: Record<TabToolName, TabHandler> = {
  list_tabs: listTabs,
  new_tab: newTab,
  activate_tab: activateTab,
  close_tab: closeTab,
  navigate: navigate,
  wait_for: waitFor,
};
