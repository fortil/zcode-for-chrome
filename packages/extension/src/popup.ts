import { getActions } from "./actionLog.js";
import { getSettings, setSettings } from "./settings.js";
import type { PopupQuery } from "./messages.js";

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const stateEl = byId("ws-state");
const enabledEl = byId<HTMLInputElement>("enabled");
const allowEvalEl = byId<HTMLInputElement>("allow-eval");
const tokenEl = byId<HTMLInputElement>("token");
const blockedEl = byId<HTMLTextAreaElement>("blocked-hosts");
const actionsEl = byId("actions");

const WS_LABELS: Record<string, string> = {
  probing: "buscando servidor...",
  connected: "conectado",
  disconnected: "desconectado",
};

async function refreshStatus(): Promise<void> {
  try {
    const status = (await chrome.runtime.sendMessage({ kind: "get_status" } satisfies PopupQuery)) as
      | { wsState?: string; port?: number | null }
      | undefined;
    if (!status) {
      stateEl.textContent = "sin respuesta del service worker";
      return;
    }
    const label = WS_LABELS[status.wsState ?? "disconnected"] ?? status.wsState ?? "?";
    stateEl.textContent = status.port ? `${label} (puerto ${status.port})` : label;
  } catch (err) {
    stateEl.textContent = `error: ${String(err)}`;
  }
}

async function loadSettings(): Promise<void> {
  const settings = await getSettings();
  enabledEl.checked = settings.enabled;
  allowEvalEl.checked = settings.allowEvaluateJs;
  tokenEl.value = settings.token;
  blockedEl.value = settings.blockedHosts.join("\n");
}

async function refreshActions(): Promise<void> {
  const entries = await getActions(20);
  actionsEl.replaceChildren();
  for (const entry of entries) {
    const li = document.createElement("li");
    const time = new Date(entry.ts).toLocaleTimeString();
    li.textContent = `${time} ${entry.tool} ${entry.host} ${entry.ok ? "ok" : `error ${entry.code ?? "?"}`}`;
    actionsEl.appendChild(li);
  }
  if (entries.length === 0) {
    const li = document.createElement("li");
    li.textContent = "sin acciones todavía";
    actionsEl.appendChild(li);
  }
}

enabledEl.addEventListener("change", () => void setSettings({ enabled: enabledEl.checked }));
allowEvalEl.addEventListener("change", () => void setSettings({ allowEvaluateJs: allowEvalEl.checked }));
tokenEl.addEventListener("change", () => void setSettings({ token: tokenEl.value.trim() }));
blockedEl.addEventListener("change", () =>
  void setSettings({
    blockedHosts: blockedEl.value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  }),
);

void refreshStatus();
void loadSettings();
void refreshActions();
// El popup vive poco; un sondeo ligero mantiene el estado al día sin tocar
// el ciclo de vida de nadie.
setInterval(() => void refreshStatus(), 2000);
setInterval(() => void refreshActions(), 2000);
