import { BridgeError } from "@zcode-for-chrome/shared";
import type { ToolName } from "@zcode-for-chrome/shared";
import { withDebugger } from "../cdp.js";

// screenshot (D7.11, S6-S7): captureVisibleTab para el viewport y
// Page.captureScreenshot con captureBeyondViewport para fullPage, con throttle
// global de 500 ms (Chrome limita captureVisibleTab a 2 llamadas/s) y
// reescalado a maxWidth en un OffscreenCanvas. La imagen viaja en memoria
// como data URL: nunca se escribe en disco.

export type ScreenshotHandler = (params: Record<string, unknown>, tab?: chrome.tabs.Tab) => Promise<unknown>;

export type ScreenshotToolName = Extract<ToolName, "screenshot">;

const THROTTLE_MS = 500;
const ACTIVATE_SETTLE_MS = 150;
const B64_CHUNK = 8192;

let lastCaptureAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function intIn(value: unknown, min: number, max: number, dflt: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return dflt;
  return Math.min(Math.max(Math.round(value), min), max);
}

async function captureFullPage(tabId: number, format: "jpeg" | "png", quality: number): Promise<string> {
  const raw = await withDebugger(tabId, (send) =>
    send("Page.captureScreenshot", { format, quality, captureBeyondViewport: true }),
  );
  const data = (raw as { data?: string }).data;
  if (!data) throw new BridgeError("CAPTURE_FAILED", "Page.captureScreenshot no devolvió imagen");
  return `data:image/${format};base64,${data}`;
}

// Decodifica la captura y, si es más ancha que maxWidth, la reescala en un
// OffscreenCanvas; devuelve la URL de datos final y sus dimensiones.
async function downscale(
  dataUrl: string,
  maxWidth: number,
  format: "jpeg" | "png",
  quality: number,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  try {
    if (bitmap.width <= maxWidth) {
      return { dataUrl, width: bitmap.width, height: bitmap.height };
    }
    const height = Math.round((bitmap.height * maxWidth) / bitmap.width);
    const canvas = new OffscreenCanvas(maxWidth, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new BridgeError("CAPTURE_FAILED", "no se pudo crear el contexto 2D para reescalar");
    ctx.drawImage(bitmap, 0, 0, maxWidth, height);
    const out = await canvas.convertToBlob({ type: `image/${format}`, quality: quality / 100 });
    const bytes = new Uint8Array(await out.arrayBuffer());
    // btoa por tramos de 8 KB: String.fromCharCode con un array entero puede
    // desbordar la pila de argumentos.
    let binary = "";
    for (let i = 0; i < bytes.length; i += B64_CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
    }
    return { dataUrl: `data:${out.type};base64,${btoa(binary)}`, width: maxWidth, height };
  } finally {
    bitmap.close();
  }
}

async function screenshot(params: Record<string, unknown>, tab?: chrome.tabs.Tab): Promise<unknown> {
  if (!tab || tab.id === undefined || tab.windowId === undefined) {
    throw new BridgeError("TAB_NOT_FOUND", "screenshot no tiene pestaña destino");
  }
  const tabId = tab.id;
  const format = params.format === "png" ? "png" : "jpeg";
  const quality = intIn(params.quality, 1, 100, 80);
  const maxWidth = intIn(params.maxWidth, 1, 7680, 1280);
  const fullPage = params.fullPage === true;
  // captureVisibleTab solo ve la pestaña activa de la ventana: si no lo es,
  // se activa (efecto lateral documentado en D7.11) y se espera al repintado.
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
    await sleep(ACTIVATE_SETTLE_MS);
  }
  const wait = lastCaptureAt + THROTTLE_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCaptureAt = Date.now();
  let raw: string;
  try {
    raw = fullPage
      ? await captureFullPage(tabId, format, quality)
      : await chrome.tabs.captureVisibleTab(tab.windowId, { format, quality });
  } catch (err) {
    if (err instanceof BridgeError) throw err;
    throw new BridgeError("CAPTURE_FAILED", `no se pudo capturar la pestaña ${tabId}: ${String(err)}`);
  }
  try {
    return await downscale(raw, maxWidth, format, quality);
  } catch (err) {
    if (err instanceof BridgeError) throw err;
    throw new BridgeError("CAPTURE_FAILED", `no se pudo procesar la captura de la pestaña ${tabId}: ${String(err)}`);
  }
}

export const SCREENSHOT_HANDLERS: Record<ScreenshotToolName, ScreenshotHandler> = {
  screenshot,
};
