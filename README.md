# ZCode for Chrome

A Chrome extension (MV3) plus an MCP server that give ZCode control of your
real browser: tabs, page reading, snapshots with stable references, clicks,
form filling, keyboard input, scrolling, screenshots, and JavaScript
evaluation. It runs on the profile you actually browse with, sessions and
extensions included.

## Architecture

```
ZCode -> MCP over stdio -> Node server (packages/server)
server -> WebSocket on 127.0.0.1, ports 8765-8785 -> extension
an offscreen document in the extension keeps that WebSocket open
the offscreen document forwards each request to the service worker via chrome.runtime.sendMessage
the service worker runs it with chrome.tabs, chrome.scripting, or chrome.debugger
the response travels back the same path to ZCode
```

The offscreen document only has access to `chrome.runtime` messaging: it has
no `chrome.storage` and no `chrome.runtime.getManifest`, so anything it needs
from those (the token, the extension version) it asks the service worker for
by message.

The repo is a monorepo with three packages: `packages/shared` (protocol types
and constants), `packages/server` (the MCP stdio server with the WebSocket
bridge), and `packages/extension` (the extension you load into Chrome).

## Install

You need Node 22+ and Chrome 120+.

1. Build:

   ```
   npm install
   npm run build
   ```

2. Open `chrome://extensions`, turn on "Developer mode" (top right corner),
   click "Load unpacked", and select this repo's `packages/extension/dist`
   directory.

3. Register the server with ZCode: in `~/.zcode/cli/config.json`, under
   `mcp.servers`, add the `zcode-for-chrome` entry from
   [`docs/zcode-config.example.json`](docs/zcode-config.example.json),
   replacing `<ABSOLUTE_PATH_TO_REPO>` with the absolute path where you cloned
   the repo. If you're not using a shared token, drop the whole `env` block.

4. Restart your ZCode session and check under Settings -> MCP that
   `zcode-for-chrome` shows as connected.

Once it's running, open the extension's popup to see the bridge status. That's
where you set the shared token, the blocked-hosts list, and the two safety
toggles described below.

## Tools

The 20 tools ZCode sees through the server. `tabId` is optional wherever it
appears: omit it and the tool acts on the active tab of the most recently
focused window. Action tools accept `ref` or `selector`; refs like `e1, e2,
e3...` come from `snapshot` or `query_selector` and expire once the page
navigates (`STALE_REF` error: take a new snapshot).

| Tool | Parameters | What it does |
| --- | --- | --- |
| `browser_status` | (none) | Bridge status: extension connection, port, versions, and `enabled` |
| `list_tabs` | (none) | Lists open tabs with URL, title, and protected-page flag |
| `new_tab` | `url?`, `active?` | Opens a tab and waits for it to finish loading (45s) |
| `activate_tab` | `tabId` | Activates a tab |
| `close_tab` | `tabId` | Closes a tab |
| `navigate` | `tabId?`, `url` or `action` | Navigates to a URL or runs `back`, `forward`, `reload`; waits for `complete` |
| `wait_for` | `tabId?`, `selector?`, `text?`, `urlContains?`, `timeoutMs?` | Waits (up to 30s) for a selector, some text, or a URL change |
| `get_page_content` | `tabId?`, `selector?`, `maxChars?` | Visible text of the page, or of the element matching selector |
| `snapshot` | `tabId?`, `viewportOnly?`, `maxElements?` | One `eN` ref per visible interactive element, with role and accessible name |
| `query_selector` | `tabId?`, `selector`, `limit?` | Finds matches for a CSS selector and assigns them refs |
| `screenshot` | `tabId?`, `format?`, `quality?`, `maxWidth?`, `fullPage?` | Captures the viewport or the full page, downscaled to `maxWidth` |
| `click` | `tabId?`, `ref` or `selector`, `button?`, `clickCount?`, `trusted?` | Clicks via the DOM; with `trusted: true` it goes through CDP with `isTrusted` events |
| `click_at` | `tabId?`, `x`, `y`, `button?`, `clickCount?` | Trusted click at viewport coordinates (CDP) |
| `hover` | `tabId?`, `ref` or `selector` | Moves the mouse to the element's center (CDP) |
| `fill` | `tabId?`, `ref` or `selector`, `value`, `clear?` | Types into an input, textarea, contenteditable, or select, with events React picks up |
| `select_option` | `tabId?`, `ref` or `selector`, `value` or `label` | Selects an option in a `<select>` |
| `type_text` | `tabId?`, `ref?`, `selector?`, `text` | Types text as real keystrokes (CDP `Input.insertText`) |
| `press_key` | `tabId?`, `key`, `modifiers?` | Presses a key with trusted events (Enter actually submits forms) |
| `scroll` | `tabId?`, `direction?`, `amount?`, `ref?`, `selector?` | Scrolls the page in a direction, or centers an element |
| `evaluate_js` | `tabId?`, `expression`, `awaitPromise?` | Evaluates a JS expression via `Runtime.evaluate`, bypassing the page's CSP |

## Security model

The extension operates your real browser, so the safeguards are on by
default and controlled from the popup:

- **Localhost only.** The server listens on `127.0.0.1` and the WebSocket
  only accepts connections whose `Origin` starts with `chrome-extension://`.
  There's no daemon: the process exits when ZCode closes its stdin.
- **Optional shared token.** Start the server with `ZCODE_CHROME_TOKEN` and
  the extension must send the same token (set it in the popup). Without a
  token, the only defense is the `Origin` header, which has a known gap: any
  local process can spoof that header and connect to the bridge. Set a token
  if your machine runs code you don't trust.
- **Protected pages.** Page tools refuse to act on `chrome://`,
  `chrome-extension://`, `devtools:`, `about:`, `edge:`, `file:`,
  `view-source:`, and the Chrome Web Store (`PROTECTED_PAGE`), plus any host
  in your `blockedHosts` list, which accepts patterns like `*.bank.com`
  (`BLOCKED_HOST`).
- **Global switch.** The popup's `enabled` toggle cuts off every tool except
  `browser_status` (`EXT_DISABLED`) and detaches any attached debuggers.
- **`evaluate_js` has its own toggle.** `allowEvaluateJs` can be turned off
  (`EVAL_DISABLED`); it runs with a 10s timeout, truncates results to 50,000
  characters, and returns exceptions as errors with their message.
- **Limits.** One in-flight command per tab, four tabs in parallel; per-tool
  server timeouts (45s navigation, 20s screenshots and `evaluate_js`, 15s
  everything else); screenshots capped at two per second.
- **Data.** Screenshots stay in memory and never touch disk. Server logs
  (stderr only) record the tool, tab, host, and duration, never `fill` or
  `type_text` values or page content. The popup keeps a rolling log of the
  last 50 actions.
- **Debug bar.** `press_key`, `type_text`, `evaluate_js`, trusted clicks, and
  full-page screenshots go through `chrome.debugger`, so Chrome shows the
  "ZCode for Chrome started debugging this browser" bar while they run. The
  attach is lazy and detaches after 30s of inactivity.

## Limitations

- Only acts on each tab's main frame; iframes are out of reach.
- `screenshot` captures the window's active tab: if the requested tab isn't
  active, it activates it first (a visible side effect).
- Chrome 137+ ignores `--load-extension`, so loading is manual from
  `chrome://extensions` and there's no automated E2E from the command line.
- CDP-based tools fail with `DEBUGGER_UNAVAILABLE` if DevTools is open on the
  target tab; close it and retry. DOM tools keep working.
- The extension connects to a single server: if you start two ZCode
  sessions, whichever starts last keeps the bridge.

## Verify

```
npm run smoke        # headless: real server + a simulated extension over WebSocket
npm run smoke:live   # against your real Chrome, with the extension loaded
```

`smoke` checks that the server exposes all 20 tools, rejects web origins and
wrong tokens, that `screenshot` returns an image, that errors carry their
code, and that the process exits when stdin closes. It also checks that
`dist/offscreen.js` doesn't call any `chrome.*` API outside what Chrome
exposes to offscreen documents.

`smoke:live` opens `https://example.com/`, waits for the page text, takes a
snapshot, clicks the link by ref, goes back, takes a screenshot, evaluates
`1+1`, presses End, and closes the tab. It needs the extension loaded and
Chrome open; it waits up to 60s for the connection.

## License

MIT, see [LICENSE](LICENSE).
