import type { ToolName } from "./protocol.js";

export const PORT_RANGE: [number, number] = [8765, 8785];
export const WS_PATH = "/ws";
export const HEALTH_PATH = "/health";
export const PROTOCOL_VERSION = 1;

export const TOOL_TIMEOUTS_MS: Record<ToolName, number> = {
  browser_status: 15000,
  list_tabs: 15000,
  new_tab: 45000,
  activate_tab: 15000,
  close_tab: 15000,
  navigate: 45000,
  wait_for: 35000,
  get_page_content: 15000,
  snapshot: 15000,
  query_selector: 15000,
  screenshot: 20000,
  click: 15000,
  click_at: 15000,
  hover: 15000,
  fill: 15000,
  select_option: 15000,
  type_text: 15000,
  press_key: 15000,
  scroll: 15000,
  evaluate_js: 20000,
  list_profiles: 5000,
  select_profile: 5000,
};

export const PROTECTED_SCHEMES: readonly string[] = [
  "chrome:",
  "chrome-extension:",
  "devtools:",
  "about:",
  "edge:",
  "file:",
  "view-source:",
];

export const PROTECTED_HOSTS: readonly string[] = [
  "chromewebstore.google.com",
];

export const LIMITS = {
  maxChars: 200000,
  defaultChars: 20000,
  maxElements: 1000,
  defaultElements: 300,
  evalResultChars: 50000,
  maxWaitMs: 30000,
} as const;
