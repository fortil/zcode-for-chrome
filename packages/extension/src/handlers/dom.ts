import { BridgeError, LIMITS } from "@zcode-for-chrome/shared";
import type { ToolName } from "@zcode-for-chrome/shared";
import { injClick, injContent, injFill, injQuery, injScroll, injSelect, injSnapshot } from "../injected.js";
import type {
  ClickResult,
  ContentResult,
  FillResult,
  QueryResult,
  ScrollResult,
  SelectResult,
  SnapshotResult,
} from "../injected.js";
// Import circular dom → input → dom: seguro porque ambas partes solo usan la
// exportación de la otra dentro de cuerpos de función, nunca al evaluarse el
// módulo.
import { trustedClick } from "./input.js";

export type DomHandler = (params: Record<string, unknown>, tab?: chrome.tabs.Tab) => Promise<unknown>;

export type DomToolName = Extract<
  ToolName,
  "get_page_content" | "snapshot" | "query_selector" | "scroll" | "click" | "fill" | "select_option"
>;

// Ejecuta una función autocontenida de injected.ts en el mundo ISOLATED de la
// pestaña y devuelve su resultado. Las páginas a las que el scripting no
// llega (chrome:// y similares) no lanzan un error tipado sino un mensaje:
// se traduce aquí a PROTECTED_PAGE. La usan también los handlers de CDP
// (input.ts) para injResolve/injFocus.
export async function exec<T>(tabId: number, fn: (arg: never) => unknown, arg: unknown): Promise<T> {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      func: fn as (arg: unknown) => unknown,
      args: [arg],
      world: "ISOLATED",
    });
  } catch (err) {
    if (String(err).includes("Cannot access contents of the page")) {
      throw new BridgeError("PROTECTED_PAGE", `no se puede ejecutar scripting en la pestaña ${tabId}`);
    }
    throw err;
  }
  return results[0]?.result as T;
}

function optString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function optInt(value: unknown, min: number, max: number, dflt: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return dflt;
  return Math.min(Math.max(Math.round(value), min), max);
}

function requireTab(tab: chrome.tabs.Tab | undefined): number {
  if (!tab || tab.id === undefined) {
    throw new BridgeError("TAB_NOT_FOUND", "la tool no tiene pestaña destino");
  }
  return tab.id;
}

function staleError(): BridgeError {
  return new BridgeError("STALE_REF", "el ref pertenece a un snapshot anterior: repite snapshot y usa un ref nuevo");
}

// Traduce el error de una función inyectada de acción al BridgeError que
// viaja por el puente.
function actionError(res: { ok: boolean; error?: string }, what: string): BridgeError {
  if (res.error === "STALE_REF") return staleError();
  if (res.error === "ELEMENT_NOT_FOUND") {
    return new BridgeError("ELEMENT_NOT_FOUND", `no se encontró el elemento de ${what}`);
  }
  return new BridgeError("INVALID_PARAMS", `el elemento de ${what} no admite esta operación`);
}

async function snapshot(params: Record<string, unknown>, tab?: chrome.tabs.Tab): Promise<unknown> {
  const tabId = requireTab(tab);
  const maxElements = optInt(params.maxElements, 1, LIMITS.maxElements, LIMITS.defaultElements);
  const snap = await exec<SnapshotResult>(tabId, injSnapshot, {
    viewportOnly: params.viewportOnly === true,
    maxElements,
  });
  const header =
    `snapshot ${snap.snapId} tab ${tabId} ${snap.url} "${snap.title}" ` +
    `(${snap.total} elementos${snap.truncated ? ", truncado" : ""})`;
  return header + "\n" + snap.lines.join("\n");
}

async function querySelector(params: Record<string, unknown>, tab?: chrome.tabs.Tab): Promise<unknown> {
  const tabId = requireTab(tab);
  const selector = optString(params.selector);
  if (!selector) throw new BridgeError("INVALID_PARAMS", "query_selector requiere selector");
  const limit = optInt(params.limit, 1, 100, 20);
  const res = await exec<QueryResult>(tabId, injQuery, { selector, limit });
  if ("error" in res && res.error === "INVALID_PARAMS") {
    throw new BridgeError("INVALID_PARAMS", `selector CSS inválido: ${selector}`);
  }
  return res.items;
}

async function getPageContent(params: Record<string, unknown>, tab?: chrome.tabs.Tab): Promise<unknown> {
  const tabId = requireTab(tab);
  const selector = optString(params.selector);
  const maxChars = optInt(params.maxChars, 1, LIMITS.maxChars, LIMITS.defaultChars);
  const res = await exec<ContentResult>(tabId, injContent, { selector, maxChars });
  if (!res.found) {
    throw new BridgeError(
      "ELEMENT_NOT_FOUND",
      selector ? `no se encontró el selector: ${selector}` : "la página no tiene body accesible",
    );
  }
  return { url: res.url, title: res.title, text: res.text, truncated: res.truncated };
}

async function scroll(params: Record<string, unknown>, tab?: chrome.tabs.Tab): Promise<unknown> {
  const tabId = requireTab(tab);
  const direction = optString(params.direction) ?? "down";
  if (direction !== "up" && direction !== "down" && direction !== "left" && direction !== "right") {
    throw new BridgeError("INVALID_PARAMS", `direction inválida: ${direction}`);
  }
  const amount = optInt(params.amount, 1, 100000, 600);
  const res = await exec<ScrollResult>(tabId, injScroll, {
    direction,
    amount,
    ref: optString(params.ref),
    selector: optString(params.selector),
  });
  if ("error" in res && res.error) {
    if (res.error === "STALE_REF") throw staleError();
    throw new BridgeError("ELEMENT_NOT_FOUND", "el elemento de scroll no se encontró");
  }
  return { ok: true, scrollX: res.scrollX, scrollY: res.scrollY };
}

async function click(params: Record<string, unknown>, tab?: chrome.tabs.Tab): Promise<unknown> {
  const tabId = requireTab(tab);
  const ref = optString(params.ref);
  const selector = optString(params.selector);
  if (!ref && !selector) throw new BridgeError("INVALID_PARAMS", "click necesita ref o selector");
  const button = optString(params.button) ?? "left";
  if (button !== "left" && button !== "right" && button !== "middle") {
    throw new BridgeError("INVALID_PARAMS", `button inválido: ${button}`);
  }
  if (params.clickCount !== undefined && params.clickCount !== 1 && params.clickCount !== 2) {
    throw new BridgeError("INVALID_PARAMS", "clickCount solo admite 1 o 2");
  }
  const clickCount = params.clickCount === 2 ? 2 : 1;
  if (params.trusted === true) {
    // trusted:true necesita un evento isTrusted: delega en la capa CDP de
    // input.ts (Input.dispatchMouseEvent sobre el centro del elemento).
    return trustedClick(params, tab);
  }
  const res = await exec<ClickResult>(tabId, injClick, { ref, selector, button, clickCount });
  if (!res.ok) throw actionError(res, "click");
  return { ok: true, tag: res.tag, text: res.text };
}

async function fill(params: Record<string, unknown>, tab?: chrome.tabs.Tab): Promise<unknown> {
  const tabId = requireTab(tab);
  const ref = optString(params.ref);
  const selector = optString(params.selector);
  if (!ref && !selector) throw new BridgeError("INVALID_PARAMS", "fill necesita ref o selector");
  if (typeof params.value !== "string") throw new BridgeError("INVALID_PARAMS", "fill requiere value (string)");
  const clear = params.clear !== false;
  const res = await exec<FillResult>(tabId, injFill, { ref, selector, value: params.value, clear });
  if (!res.ok) throw actionError(res, "fill");
  return {
    ok: true,
    tag: res.tag,
    type: res.type,
    ...(res.selectedValue !== undefined ? { selectedValue: res.selectedValue } : {}),
  };
}

async function selectOption(params: Record<string, unknown>, tab?: chrome.tabs.Tab): Promise<unknown> {
  const tabId = requireTab(tab);
  const ref = optString(params.ref);
  const selector = optString(params.selector);
  if (!ref && !selector) throw new BridgeError("INVALID_PARAMS", "select_option necesita ref o selector");
  const value = typeof params.value === "string" ? params.value : undefined;
  const label = typeof params.label === "string" ? params.label : undefined;
  if (value === undefined && label === undefined) {
    throw new BridgeError("INVALID_PARAMS", "select_option requiere value o label");
  }
  const res = await exec<SelectResult>(tabId, injSelect, { ref, selector, value, label });
  if (!res.ok) throw actionError(res, "select_option");
  return { ok: true, selectedValue: res.selectedValue };
}

export const DOM_HANDLERS: Record<DomToolName, DomHandler> = {
  get_page_content: getPageContent,
  snapshot,
  query_selector: querySelector,
  scroll,
  click,
  fill,
  select_option: selectOption,
};
