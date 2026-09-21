import type { BridgeRequest, BridgeResponse } from "@zcode-for-chrome/shared";

export type OffscreenToSw =
  | { kind: "bridge_request"; req: BridgeRequest }
  | { kind: "ws_state"; state: "probing" | "connected" | "disconnected"; port?: number }
  | { kind: "get_hello" };

// Sent from the service worker to the offscreen document: drop every socket
// and reconnect (used when the profile label changes so the next hello
// carries it).
export type SwToOffscreenCommand = { kind: "reconnect" };

// Lo que el offscreen document no puede leer solo: ni chrome.storage ni
// chrome.runtime.getManifest están expuestos en ese contexto.
export interface HelloInfo {
  token: string;
  extensionVersion: string;
  profileLabel: string;
}

// La respuesta del SW al offscreen viaja como valor de retorno del
// sendMessage (canal de respuesta), no como mensaje propio; este tipo
// documenta la forma que viaja.
export type SwToOffscreen = { kind: "bridge_response"; res: BridgeResponse };

export interface SettingsPatch {
  enabled?: boolean;
  token?: string;
  profileLabel?: string;
  blockedHosts?: string[];
  allowEvaluateJs?: boolean;
}

export type PopupQuery = { kind: "get_status" } | { kind: "set_settings"; patch: SettingsPatch };
