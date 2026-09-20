---
tema: offscreen-document-chrome-api-restriction
proyecto: chrome-extension
tipo: chat
fecha: 2026-09-20
---

# chrome-extension: bug en cascada del offscreen document, causa raíz por restricción de plataforma

## Resumen
Run de diagnóstico (MODO=debug) sobre `zcode-for-chrome`, misma rama `tasky/zcode-chrome-bridge` (PR #1 aún abierto) del run anterior. El usuario reportó tres errores en cascada al probar el gate `smoke:live` en Chrome real, cada uno tras un parche puntual del orquestador en vivo sin diagnóstico. Este run hizo research real (fable, plan a max) y confirmó con la fuente primaria de Chromium que los errores 2 y 3 eran el mismo bug: el offscreen document corre en un contexto restringido que nunca soportó `chrome.storage` ni `chrome.runtime.getManifest`. Plan corrido en 6 pasos, glm auditó con 3 hallazgos menores (corregidos en PLAN.md sobre PLAN.r1.md), WORK_REVIEW: APROBADO CON OBSERVACIONES. Verificación offline (build + typecheck + smoke) en verde. El Paso 6 (gate E2E real) quedó pendiente porque Chrome seguía ejecutando el bundle viejo en memoria — requiere que el usuario recargue la extensión.

## Decisiones y acuerdos
- Un solo mensaje `get_hello` (SW → offscreen) que devuelve `{token, extensionVersion}`, en vez de mantener `get_token` y sumar `get_version`: una sola fuente de verdad, sin round-trip extra.
- Regla dura: el offscreen document solo usa `chrome.runtime.{sendMessage,onMessage,connect,onConnect,getURL,id,lastError}`. Se documenta en la cabecera de `offscreen.ts` y se hace cumplir con un grep estático sobre el **bundle compilado** (`dist/offscreen.js`), no sobre el `.ts`, porque `@types/chrome` no modela contextos y un import transitivo (p. ej. desde `settings.ts`) podría reintroducir `chrome.storage` sin que `tsc` proteste.
- Si `get_hello` falla, el offscreen cierra el socket y deja que el bucle de reconexión reintente con backoff, en vez de mandar un hello a medias (el servidor lo rechazaría igual por timeout).
- Se conserva el lock de `ensureOffscreen()` de la sesión anterior (carrera real e independiente, `void ensureOffscreen()` top-level + `onInstalled` + `onStartup`).

## Supuestos que resultaron falsos
- El usuario planteó como hipótesis un problema de timing o "extension context invalidated" por recargas repetidas. Ambas se descartaron: la doc oficial de Chrome ("the `chrome.runtime` API is the only extensions API supported by offscreen documents") y `extensions/common/api/_api_features.json` de Chromium (main y tag `120.0.6099.0`, el `minimum_chrome_version` del manifest) confirman que `runtime.getManifest` y `storage` nunca tuvieron el contexto `offscreen_extension`. No es regresión de Chrome 153: el código de `sendHello()` nunca pudo funcionar; el live de la sesión anterior fue la primera vez que esa ruta corrió en un Chrome real.
- El error 1 ("Only a single offscreen document") sí era un bug distinto (carrera de doble `createDocument()`), ya resuelto con el lock de la sesión anterior — no formaba parte de la cascada de causa única.
- GLM detectó en la review que un `grep -c 'context invalidated' BRIEF.md` que el plan declaraba en `0` en realidad da `1` (la mención hipotética del usuario, no un error real): hallazgo menor, corregido acotando el grep a los literales de los tres errores.

## Datos útiles para el futuro
- Comando decisivo: `npm run build && ! grep -nE 'chrome\.(storage|runtime\.getManifest)' packages/extension/dist/offscreen.js && grep -q 'checkOffscreenApiSurface' packages/server/scripts/smoke.mjs && npm run smoke` → `SMOKE OK`.
- Guardarraíl nuevo: `checkOffscreenApiSurface()` en `packages/server/scripts/smoke.mjs`, corre en offline y en `--live`; falla el build si `dist/offscreen.js` usa una API `chrome.*` fuera de `OFFSCREEN_ALLOWED_APIS`.
- Verificación de causa raíz reproducible: `curl -sL https://raw.githubusercontent.com/chromium/chromium/main/extensions/common/api/_api_features.json | grep -A5 '"runtime.getManifest"' | grep -c offscreen_extension` → `0`.
- Firma para distinguir "bundle viejo en memoria" de "regresión del fix nuevo": el bundle viejo produce "hello timeout" repetidos en el servidor con backoff creciente (socket que queda abierto sin hello); el código nuevo cierra el socket él mismo al fallar `get_hello`, así que un `smoke:live` con el fix real nunca debería mostrar esa firma.
- `dist/` está en `.gitignore`: cualquier comprobación sobre el bundle exige `npm run build` antes.

## Pendientes que quedaron
- [ ] Paso 6 del plan (gate E2E real): el usuario debe recargar la extensión en `chrome://extensions` (Chrome 137+ no soporta `--load-extension`, así que no es automatizable) y correr `npm run smoke:live` — debe terminar en `LIVE OK` con `extensionVersion: "0.1.0"` en el log del servidor y sin `TypeError` de `chrome.*` en la consola del offscreen.
- [ ] PR #1 sigue abierto sobre `tasky/zcode-chrome-bridge`, sin mergear.

## Enlaces
- Doc en el repo (fuente de verdad): PLAN.md
