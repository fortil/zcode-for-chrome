import { BridgeError } from "@zcode-for-chrome/shared";

// Capa CDP (D3): attach perezoso por pestaña y detach automático a los 30 s
// sin uso, para que la barra "started debugging this browser" solo aparezca
// mientras hay tools de teclado/clicks trusted/evaluate/screenshot fullPage
// en vuelo.

export type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

const ATTACH_IDLE_MS = 30000;

interface Attached {
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

const attached = new Map<number, Attached>();

function forget(tabId: number): void {
  const entry = attached.get(tabId);
  if (!entry) return;
  if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
  attached.delete(tabId);
}

function detachQuiet(tabId: number): void {
  void chrome.debugger.detach({ tabId }).catch(() => undefined);
}

// Reprograma el detach por inactividad: cada uso de withDebugger le da otros
// 30 s de vida al attach.
function scheduleDetach(tabId: number): void {
  const entry = attached.get(tabId);
  if (!entry) return;
  if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    forget(tabId);
    detachQuiet(tabId);
  }, ATTACH_IDLE_MS);
}

// S4: cuando el interruptor global pasa a false se despegan todos.
export function detachAll(): void {
  for (const tabId of Array.from(attached.keys())) {
    forget(tabId);
    detachQuiet(tabId);
  }
}

async function ensureAttached(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (err) {
    if (String(err).includes("already attached")) {
      throw new BridgeError(
        "DEBUGGER_UNAVAILABLE",
        `otro cliente ya tiene el debugger de la pestaña ${tabId}`,
        "Cierra DevTools en esa pestaña",
      );
    }
    throw err;
  }
  attached.set(tabId, { idleTimer: undefined });
}

// Adjunta el debugger a la pestaña si no lo estaba, ejecuta fn con un send
// que habla el protocolo DevTools y reprograma el detach al terminar.
export async function withDebugger<T>(tabId: number, fn: (send: CdpSend) => Promise<T>): Promise<T> {
  await ensureAttached(tabId);
  try {
    return await fn((method, params) => chrome.debugger.sendCommand({ tabId }, method, params));
  } finally {
    scheduleDetach(tabId);
  }
}

// El usuario puede cancelar el debugging desde la barra o abrir DevTools: el
// attach deja de existir y hay que limpiar el mapa para que el próximo uso
// reintente el attach.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) forget(source.tabId);
});

// Pestaña cerrada: el target desaparece, solo queda limpiar el mapa.
chrome.tabs.onRemoved.addListener((tabId) => {
  forget(tabId);
});
