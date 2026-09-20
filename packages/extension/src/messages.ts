import type { BridgeRequest, BridgeResponse } from "@zcode-for-chrome/shared";

export type OffscreenToSw =
  | { kind: "bridge_request"; req: BridgeRequest }
  | { kind: "ws_state"; state: "probing" | "connected" | "disconnected"; port?: number };

// La respuesta del SW al offscreen viaja como valor de retorno del
// sendMessage (canal de respuesta), no como mensaje propio; este tipo
// documenta la forma que viaja.
export type SwToOffscreen = { kind: "bridge_response"; res: BridgeResponse };

export interface SettingsPatch {
  enabled?: boolean;
  token?: string;
  blockedHosts?: string[];
  allowEvaluateJs?: boolean;
}

export type PopupQuery = { kind: "get_status" } | { kind: "set_settings"; patch: SettingsPatch };
