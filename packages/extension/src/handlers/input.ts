import { BridgeError } from "@zcode-for-chrome/shared";
import type { ToolName } from "@zcode-for-chrome/shared";
import { withDebugger } from "../cdp.js";
import type { CdpSend } from "../cdp.js";
import { injFocus, injResolve } from "../injected.js";
import type { FocusResult, ResolveResult } from "../injected.js";
import { modifiersMask, resolveKey } from "../keys.js";
import { exec } from "./dom.js";

// Tools que necesitan eventos trusted o texto real de teclado y por tanto van
// por chrome.debugger (D3/D7.17-18): press_key, type_text, hover, click_at y
// el click con trusted:true (trustedClick, que consume el handler DOM).

export type InputHandler = (params: Record<string, unknown>, tab?: chrome.tabs.Tab) => Promise<unknown>;

export type InputToolName = Extract<ToolName, "press_key" | "type_text" | "hover" | "click_at">;

function optString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
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

// Los valores de button de los params (left|right|middle) coinciden con los
// nombres que espera Input.dispatchMouseEvent.
function buttonOf(params: Record<string, unknown>): "left" | "right" | "middle" {
  const button = optString(params.button) ?? "left";
  if (button !== "left" && button !== "right" && button !== "middle") {
    throw new BridgeError("INVALID_PARAMS", `button inválido: ${button}`);
  }
  return button;
}

function clickCountOf(params: Record<string, unknown>): 1 | 2 {
  if (params.clickCount !== undefined && params.clickCount !== 1 && params.clickCount !== 2) {
    throw new BridgeError("INVALID_PARAMS", "clickCount solo admite 1 o 2");
  }
  return params.clickCount === 2 ? 2 : 1;
}

async function pressKey(params: Record<string, unknown>, tab?: chrome.tabs.Tab): Promise<unknown> {
  const tabId = requireTab(tab);
  const name = optString(params.key);
  if (!name) throw new BridgeError("INVALID_PARAMS", "press_key requiere key");
  const def = resolveKey(name);
  const modifiers = Array.isArray(params.modifiers)
    ? modifiersMask(params.modifiers.map((mod) => String(mod)))
    : 0;
  await withDebugger(tabId, async (send) => {
    const base = {
      modifiers,
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode,
      nativeVirtualKeyCode: def.windowsVirtualKeyCode,
    };
    // text solo en keyDown: es lo que genera el evento de carácter (el Enter
    // que envía un formulario, la letra que escribe).
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      ...base,
      ...(def.text !== undefined ? { text: def.text, unmodifiedText: def.text } : {}),
    });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  });
  return { ok: true };
}

async function typeText(params: Record<string, unknown>, tab?: chrome.tabs.Tab): Promise<unknown> {
  const tabId = requireTab(tab);
  const text = params.text;
  if (typeof text !== "string") throw new BridgeError("INVALID_PARAMS", "type_text requiere text (string)");
  const ref = optString(params.ref);
  const selector = optString(params.selector);
  await withDebugger(tabId, async (send) => {
    if (ref || selector) {
      const focus = await exec<FocusResult>(tabId, injFocus, { ref, selector });
      if (!focus.ok) {
        throw focus.error === "STALE_REF"
          ? staleError()
          : new BridgeError("ELEMENT_NOT_FOUND", "no se encontró el elemento donde escribir");
      }
    }
    await send("Input.insertText", { text });
  });
  return { ok: true };
}

// Localiza el elemento y devuelve el centro de su rect en coordenadas del
// viewport, que es el sistema que usa Input.dispatchMouseEvent.
async function centerOf(
  tabId: number,
  ref: string | undefined,
  selector: string | undefined,
): Promise<{ x: number; y: number; tag: string; text: string }> {
  const res = await exec<ResolveResult>(tabId, injResolve, { ref, selector });
  if (!res.found || !res.rect) {
    throw res.stale
      ? staleError()
      : new BridgeError("ELEMENT_NOT_FOUND", "no se encontró el elemento sobre el que actuar");
  }
  return {
    x: res.rect.x + res.rect.w / 2,
    y: res.rect.y + res.rect.h / 2,
    tag: res.tag ?? "",
    text: res.text ?? "",
  };
}

async function mouseClick(
  send: CdpSend,
  x: number,
  y: number,
  button: "left" | "right" | "middle",
  clickCount: 1 | 2,
): Promise<void> {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount });
}

// click {trusted:true} (D7.12): evento isTrusted vía CDP. Lo llama el handler
// DOM de click cuando params.trusted === true.
export async function trustedClick(params: Record<string, unknown>, tab?: chrome.tabs.Tab): Promise<unknown> {
  const tabId = requireTab(tab);
  const ref = optString(params.ref);
  const selector = optString(params.selector);
  if (!ref && !selector) throw new BridgeError("INVALID_PARAMS", "click necesita ref o selector");
  const button = buttonOf(params);
  const clickCount = clickCountOf(params);
  const center = await centerOf(tabId, ref, selector);
  await withDebugger(tabId, (send) => mouseClick(send, center.x, center.y, button, clickCount));
  return { ok: true, tag: center.tag, text: center.text };
}

async function hover(params: Record<string, unknown>, tab?: chrome.tabs.Tab): Promise<unknown> {
  const tabId = requireTab(tab);
  const ref = optString(params.ref);
  const selector = optString(params.selector);
  if (!ref && !selector) throw new BridgeError("INVALID_PARAMS", "hover necesita ref o selector");
  const center = await centerOf(tabId, ref, selector);
  await withDebugger(tabId, (send) =>
    send("Input.dispatchMouseEvent", { type: "mouseMoved", x: center.x, y: center.y, button: "none" }),
  );
  return { ok: true };
}

async function clickAt(params: Record<string, unknown>, tab?: chrome.tabs.Tab): Promise<unknown> {
  const tabId = requireTab(tab);
  const x = params.x;
  const y = params.y;
  if (typeof x !== "number" || typeof y !== "number") {
    throw new BridgeError("INVALID_PARAMS", "click_at requiere x e y (números)");
  }
  const button = buttonOf(params);
  const clickCount = clickCountOf(params);
  await withDebugger(tabId, (send) => mouseClick(send, x, y, button, clickCount));
  return { ok: true };
}

export const INPUT_HANDLERS: Record<InputToolName, InputHandler> = {
  press_key: pressKey,
  type_text: typeText,
  hover,
  click_at: clickAt,
};
