export type ToolName =
  | "browser_status"
  | "list_tabs"
  | "new_tab"
  | "activate_tab"
  | "close_tab"
  | "navigate"
  | "wait_for"
  | "get_page_content"
  | "snapshot"
  | "query_selector"
  | "screenshot"
  | "click"
  | "click_at"
  | "hover"
  | "fill"
  | "select_option"
  | "type_text"
  | "press_key"
  | "scroll"
  | "evaluate_js";

export type ErrorCode =
  | "EXT_NOT_CONNECTED"
  | "EXT_DISABLED"
  | "PROTECTED_PAGE"
  | "BLOCKED_HOST"
  | "TAB_NOT_FOUND"
  | "ELEMENT_NOT_FOUND"
  | "STALE_REF"
  | "TIMEOUT"
  | "DEBUGGER_UNAVAILABLE"
  | "EVAL_DISABLED"
  | "INVALID_PARAMS"
  | "CAPTURE_FAILED"
  | "INTERNAL";

export interface Hello {
  type: "hello";
  token?: string;
  extensionVersion: string;
  chromeVersion: string;
}

export interface HelloAck {
  type: "hello_ack";
  serverVersion: string;
}

export interface BridgeRequest {
  type: "request";
  id: string;
  tool: ToolName;
  params: Record<string, unknown>;
}

export interface BridgeErrorPayload {
  code: ErrorCode;
  message: string;
  hint?: string;
}

export type BridgeResponse =
  | { type: "response"; responseTo: string; ok: true; result: unknown }
  | { type: "response"; responseTo: string; ok: false; error: BridgeErrorPayload };

export class BridgeError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.hint = hint;
  }
}
