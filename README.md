# ZCode for Chrome

Extensión de Chrome (MV3) más un servidor MCP que le dan a ZCode control de tu
navegador real: pestañas, lectura de páginas, snapshots con referencias
estables, clicks, formularios, teclado, scroll, capturas de pantalla y
evaluación de JavaScript. Opera sobre el perfil con el que navegas, con sus
sesiones iniciadas y sus extensiones.

## Arquitectura

```
ZCode -> MCP por stdio -> servidor Node (packages/server)
servidor -> WebSocket en 127.0.0.1, puertos 8765 a 8785 -> extensión
un offscreen document de la extensión mantiene ese WebSocket abierto
el offscreen reenvía cada petición al service worker con chrome.runtime.sendMessage
el service worker la ejecuta con chrome.tabs, chrome.scripting o chrome.debugger
la respuesta regresa por el mismo camino hasta ZCode
```

El offscreen document solo dispone de la mensajería de `chrome.runtime`: no
tiene `chrome.storage` ni `chrome.runtime.getManifest`, así que lo que
necesita de ahí (el token y la versión de la extensión) se lo pide al service
worker por mensaje.

El repositorio es un monorepo con tres paquetes: `packages/shared` (tipos y
constantes del protocolo), `packages/server` (servidor MCP stdio con el puente
WebSocket) y `packages/extension` (la extensión que se carga en Chrome).

## Instalación

Necesitas Node 22 o superior y Chrome 120 o superior.

1. Compila:

   ```
   npm install
   npm run build
   ```

2. Abre `chrome://extensions`, activa el "Modo de desarrollador" (esquina
   superior derecha), pulsa "Cargar descomprimida" y selecciona el directorio
   `packages/extension/dist` de este repo.

3. Registra el servidor en ZCode: en `~/.zcode/cli/config.json`, dentro de
   `mcp.servers`, añade la entrada `zcode-for-chrome` de
   [`docs/zcode-config.example.json`](docs/zcode-config.example.json)
   sustituyendo `<ABSOLUTE_PATH_TO_REPO>` por la ruta absoluta donde tienes el
   repo. Si no vas a usar token compartido, borra el bloque `env` entero.

4. Reinicia la sesión de ZCode y comprueba en Settings -> MCP que
   `zcode-for-chrome` aparece como conectado.

Al terminar, abre el popup de la extensión para ver el estado del puente. Ahí
se configuran el token compartido, la lista de hosts bloqueados y los dos
interruptores de seguridad descritos más abajo.

## Herramientas

Las 20 tools que ZCode ve a través del servidor. `tabId` es opcional donde
aparece: si se omite, la tool actúa sobre la pestaña activa de la última
ventana enfocada. Las tools de acción aceptan `ref` o `selector`; los refs
`e1, e2, e3...` los asigna `snapshot` o `query_selector` y caducan cuando la
página navega (error `STALE_REF`: repite el snapshot).

| Tool | Parámetros | Qué hace |
| --- | --- | --- |
| `browser_status` | (ninguno) | Estado del puente: conexión de la extensión, puerto, versiones y `enabled` |
| `list_tabs` | (ninguno) | Lista las pestañas abiertas con URL, título y marca de página protegida |
| `new_tab` | `url?`, `active?` | Abre una pestaña y espera a que termine de cargar (45 s) |
| `activate_tab` | `tabId` | Activa una pestaña |
| `close_tab` | `tabId` | Cierra una pestaña |
| `navigate` | `tabId?`, `url` o `action` | Navega a una URL o ejecuta `back`, `forward`, `reload`; espera a `complete` |
| `wait_for` | `tabId?`, `selector?`, `text?`, `urlContains?`, `timeoutMs?` | Espera (hasta 30 s) a que aparezca un selector, un texto o un cambio de URL |
| `get_page_content` | `tabId?`, `selector?`, `maxChars?` | Texto visible de la página o del elemento dado por selector |
| `snapshot` | `tabId?`, `viewportOnly?`, `maxElements?` | Un ref `eN` por elemento interactivo visible, con rol y nombre accesible |
| `query_selector` | `tabId?`, `selector`, `limit?` | Busca por selector CSS y asigna refs a los matches |
| `screenshot` | `tabId?`, `format?`, `quality?`, `maxWidth?`, `fullPage?` | Captura del viewport o de la página completa, reescalada a `maxWidth` |
| `click` | `tabId?`, `ref` o `selector`, `button?`, `clickCount?`, `trusted?` | Click por DOM; con `trusted: true` lo hace por CDP con eventos `isTrusted` |
| `click_at` | `tabId?`, `x`, `y`, `button?`, `clickCount?` | Click trusted en coordenadas del viewport (CDP) |
| `hover` | `tabId?`, `ref` o `selector` | Mueve el ratón al centro del elemento (CDP) |
| `fill` | `tabId?`, `ref` o `selector`, `value`, `clear?` | Escribe en input, textarea, contenteditable o select, con eventos que React detecta |
| `select_option` | `tabId?`, `ref` o `selector`, `value` o `label` | Selecciona una opción de un `<select>` |
| `type_text` | `tabId?`, `ref?`, `selector?`, `text` | Escribe texto como teclado real (CDP `Input.insertText`) |
| `press_key` | `tabId?`, `key`, `modifiers?` | Pulsa una tecla con eventos trusted (Enter sí envía formularios) |
| `scroll` | `tabId?`, `direction?`, `amount?`, `ref?`, `selector?` | Desplaza la página en una dirección o centra un elemento |
| `evaluate_js` | `tabId?`, `expression`, `awaitPromise?` | Evalúa una expresión JS vía `Runtime.evaluate`, sin límites de CSP de la página |

## Modelo de seguridad

La extensión opera tu navegador real, así que las salvaguardas están activas
por defecto y se controlan desde el popup:

- **Solo localhost.** El servidor escucha en `127.0.0.1` y el WebSocket solo
  acepta conexiones cuyo `Origin` empiece por `chrome-extension://`. No hay
  daemon: el proceso muere cuando ZCode cierra su stdin.
- **Token compartido opcional.** Si arrancas el servidor con
  `ZCODE_CHROME_TOKEN`, la extensión debe enviar el mismo token (se configura
  en el popup). Sin token, la única defensa es la cabecera `Origin`, y eso
  tiene un agujero conocido: cualquier proceso local puede falsear esa
  cabecera y conectarse al puente. Si en tu máquina corre código en el que no
  confías, pon token.
- **Páginas protegidas.** Las tools de página se niegan a actuar sobre
  `chrome://`, `chrome-extension://`, `devtools:`, `about:`, `edge:`, `file:`,
  `view-source:` y la Chrome Web Store (`PROTECTED_PAGE`), y sobre los hosts
  de tu lista `blockedHosts`, que admite patrones como `*.banco.com`
  (`BLOCKED_HOST`).
- **Interruptor global.** El toggle `enabled` del popup corta todas las tools
  salvo `browser_status` (`EXT_DISABLED`) y suelta los debuggers attachados.
- **`evaluate_js` con toggle propio.** `allowEvaluateJs` se puede apagar
  (`EVAL_DISABLED`); con timeout de 10 s, resultado truncado a 50 000
  caracteres y las excepciones devueltas como error con su mensaje.
- **Límites.** Un comando en vuelo por pestaña y cuatro pestañas en paralelo;
  timeouts por tool en el servidor (45 s navegación, 20 s capturas y
  `evaluate_js`, 15 s el resto); capturas a dos por segundo como máximo.
- **Datos.** Las capturas viajan en memoria y nunca se escriben en disco. Los
  logs del servidor (solo stderr) registran tool, pestaña, host y duración;
  nunca los valores de `fill` o `type_text` ni contenido de páginas. El popup
  guarda un registro circular con las últimas 50 acciones.
- **Barra de depuración.** `press_key`, `type_text`, `evaluate_js`, los clicks
  trusted y las capturas de página completa usan `chrome.debugger`, y mientras
  tanto Chrome muestra la barra "ZCode for Chrome started debugging this
  browser". El attach es perezoso y se desprende a los 30 s de inactividad.

## Limitaciones

- Solo actúa sobre el frame principal de cada pestaña; los iframes quedan
  fuera.
- `screenshot` captura la pestaña activa de la ventana: si la pedida no lo es,
  la activa antes (efecto lateral visible).
- Chrome 137 y superior ignoran `--load-extension`, así que la carga es manual
  desde `chrome://extensions` y no hay E2E automatizable por línea de
  comandos.
- Las tools que usan CDP fallan con `DEBUGGER_UNAVAILABLE` si tienes DevTools
  abierto en la pestaña destino; ciérralo y reintenta. Las tools de DOM
  siguen funcionando.
- La extensión conecta con un solo servidor: si abres dos sesiones de ZCode,
  la última que arranque se queda el puente.

## Verificar

```
npm run smoke        # headless: servidor real + extensión simulada por WebSocket
npm run smoke:live   # contra tu Chrome real, con la extensión cargada
```

`smoke` comprueba que el servidor expone las 20 tools, que rechaza origins web
y tokens erróneos, que `screenshot` devuelve una imagen, que los errores
viajan con su código y que el proceso muere al cerrar stdin. También comprueba
que `dist/offscreen.js` no usa APIs `chrome.*` fuera de las que Chrome expone
en los offscreen documents.

`smoke:live` abre `https://example.com/`, espera el texto de la página, hace
snapshot, pulsa el link por ref, vuelve atrás, captura pantalla, evalúa
`1+1`, pulsa End y cierra la pestaña. Necesita la extensión cargada y Chrome
abierto; espera hasta 60 s a que se conecte.

## Licencia

MIT, ver [LICENSE](LICENSE).
