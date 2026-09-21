import { BridgeError, LIMITS } from "@zcode-for-chrome/shared";
import type { ToolName } from "@zcode-for-chrome/shared";
import { withDebugger } from "../cdp.js";
import { getSettings } from "../settings.js";

// evaluate_js (D7.20, S5): Runtime.evaluate vía chrome.debugger, que ignora la
// CSP de la página. Detrás del toggle allowEvaluateJs del popup.

export type EvaluateHandler = (params: Record<string, unknown>, tab?: chrome.tabs.Tab) => Promise<unknown>;

export type EvaluateToolName = Extract<ToolName, "evaluate_js">;

interface EvaluateResponse {
  result?: { value?: unknown };
  exceptionDetails?: {
    text: string;
    exception?: { description?: string };
  };
}

async function evaluateJs(params: Record<string, unknown>, tab?: chrome.tabs.Tab): Promise<unknown> {
  if (!tab || tab.id === undefined) {
    throw new BridgeError("TAB_NOT_FOUND", "evaluate_js no tiene pestaña destino");
  }
  const expression = params.expression;
  if (typeof expression !== "string" || expression === "") {
    throw new BridgeError("INVALID_PARAMS", "evaluate_js requiere expression (string)");
  }
  const settings = await getSettings();
  if (!settings.allowEvaluateJs) {
    throw new BridgeError("EVAL_DISABLED", "evaluate_js está desactivado en el popup");
  }
  const awaitPromise = params.awaitPromise !== false;
  const raw = await withDebugger(tab.id, (send) =>
    send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise, timeout: 10000 }),
  );
  const res = raw as EvaluateResponse;
  if (res.exceptionDetails) {
    const details = res.exceptionDetails;
    throw new BridgeError("INTERNAL", `${details.text}: ${details.exception?.description ?? ""}`);
  }
  // returnByValue ya serializa; aquí solo se acota el tamaño del resultado.
  let serialized = JSON.stringify(res.result?.value === undefined ? null : res.result?.value);
  if (serialized.length > LIMITS.evalResultChars) {
    serialized = serialized.slice(0, LIMITS.evalResultChars) + "…[truncated]";
  }
  return { value: serialized };
}

export const EVAL_HANDLERS: Record<EvaluateToolName, EvaluateHandler> = {
  evaluate_js: evaluateJs,
};
