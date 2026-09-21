import { detachAll } from "./cdp.js";

export interface Settings {
  enabled: boolean;
  token: string;
  /** Label identifying this Chrome profile to the bridge (see list_profiles). */
  profileLabel: string;
  blockedHosts: string[];
  allowEvaluateJs: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  token: "",
  profileLabel: "default",
  blockedHosts: [],
  allowEvaluateJs: true,
};

// Cada campo vive bajo su propia clave en local storage: solo el service
// worker puede leerlas; el token llega al offscreen document por get_hello.
export async function getSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(DEFAULT_SETTINGS)) as Partial<Settings>;
  return {
    enabled: typeof stored.enabled === "boolean" ? stored.enabled : DEFAULT_SETTINGS.enabled,
    token: typeof stored.token === "string" ? stored.token : DEFAULT_SETTINGS.token,
    profileLabel:
      typeof stored.profileLabel === "string" && stored.profileLabel.trim() !== ""
        ? stored.profileLabel.trim()
        : DEFAULT_SETTINGS.profileLabel,
    blockedHosts: Array.isArray(stored.blockedHosts)
      ? stored.blockedHosts.filter((host): host is string => typeof host === "string")
      : DEFAULT_SETTINGS.blockedHosts,
    allowEvaluateJs:
      typeof stored.allowEvaluateJs === "boolean" ? stored.allowEvaluateJs : DEFAULT_SETTINGS.allowEvaluateJs,
  };
}

export async function setSettings(patch: Partial<Settings>): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await chrome.storage.local.set(patch as Record<string, unknown>);
  // S4: al apagar el interruptor global se despegan todos los debuggers.
  if (patch.enabled === false) detachAll();
}
