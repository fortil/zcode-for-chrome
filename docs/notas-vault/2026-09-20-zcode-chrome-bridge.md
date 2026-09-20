---
tema: zcode-chrome-bridge-run-tasky
proyecto: chrome-extension
tipo: chat
fecha: 2026-09-20
---

# chrome-extension: cierre del run tasky de la extensión MCP puente

## Resumen
Se pidió crear una extensión de Chrome MV3 controlable desde ZCode, partiendo de un
plan externo (PLAN.md) revisado con MODO=grande, MODELS=fable,kimi,glm y PLAN_REVIEW=y:
fable replanificó primero, kimi y glm auditaron en cadena, fable corrigió. Con Q=y el
usuario amplió el alcance a mitad de la fase de research: de las 7 tools MVP del
borrador original a 20 tools con control completo (click, fill, select, teclado,
scroll, screenshot, evaluate_js) mediante un modelo híbrido DOM+CDP, para igualar a
las extensiones de navegador de Claude/ChatGPT/Kimi. La review de plan (kimi luego
glm arbitrando) rechazó la primera versión por 7 hallazgos de secuenciación, fable los
corrigió en una vuelta. Ejecución en 6 tramos, todos cerrados con veredicto
aprobatorio; dos tramos necesitaron una segunda vuelta por bugs reales encontrados en
review. El Paso 15 (registro MCP global + gate E2E) lo ejecutó el orquestador a mano,
por decisión explícita del usuario, y queda con una acción pendiente del usuario.

## Decisiones y acuerdos
- Alcance ampliado a 20 tools con modelo híbrido DOM+CDP en vez del MVP de 7 tools:
  decisión explícita del usuario en la fase de preguntas del planner, para que ZCode
  tenga paridad de interacción con un agente "computer use" sobre el navegador real.
- Repo privado (`fortil/zcode-for-chrome`) en este run, con reescritura del commit
  inicial (email noreply) antes de subirlo; pasar a público queda para un run
  posterior tras revisar README y datos sensibles.
- Servidor MCP registrado en `~/.zcode/cli/config.json` global (mismo patrón que los
  otros 4 servidores del usuario), no en el repo — el repo solo trae
  `docs/zcode-config.example.json` con placeholders.
- Cuando el plan pedía operaciones que `tasky-implement` prohíbe por regla dura
  (git-ops/push en el tramo 1, y la config global + gate manual del Paso 15), el
  usuario eligió que el orquestador las ejecutara manualmente en vez de forzar una
  replanificación del plan para evitarlas.

## Supuestos que resultaron falsos
- El plan asumía que el implementador podía hacer `git commit`/`push` en los Pasos
  1-2. Falso: `tasky-implement` no da acceso de escritura a git. Kimi lo detectó en
  la review del tramo 1 como hallazgo estructural del plan, no de la ejecución.
- Tramo 2: el EXECUTION_REPORT v1 daba el keepalive del WebSocket por correcto, pero
  el `setInterval` no se limpiaba al cerrarse la conexión de forma natural (solo en
  `stop()`) — fuga real de timers. Kimi lo cazó reproduciendo el cierre, no leyendo
  el diff.
- Tramo 4: el EXECUTION_REPORT v1 afirmaba explícitamente que no había handlers
  placeholder inalcanzables (declaraba 6 cuando quedaban 10). En realidad
  `dispatch.ts` tenía un bug de spread: claves explícitas
  (`click/fill/select_option/scroll: notImplemented(...)`) se declaraban después del
  spread `...DOM_HANDLERS`, pisando a los 4 handlers reales y dejándolos
  inalcanzables. Kimi lo encontró re-ejecutando el comando decisivo y leyendo el
  dispatch real, no confiando en el reporte.

## Datos útiles para el futuro
- Comando decisivo del plan: build completo del monorepo + smoke — falla si el
  servidor no expone exactamente 20 tools, si acepta Origins/tokens erróneos, si
  `screenshot` no devuelve `image`, si los errores no llegan como `isError` con
  código, si el timeout no se aplica o si el proceso no muere al cerrar stdin.
  Válido en estado final a partir del Paso 7 (cuando existe `packages/extension`).
- Verificación E2E con Chrome real no automatizable (`--load-extension` no funciona
  en Chrome 137+): `npm run smoke:live`, gate manual descrito en el README.
- Config MCP global: `~/.zcode/cli/config.json`, con backup previo
  `~/.zcode/cli/config.json.bak-20260920` hecho por el orquestador antes de editar;
  entrada `zcode-for-chrome` en forma stdio completa (`type`,`command`,`args`), sin
  token (modo confiado documentado), preservando las 4 entradas previas
  (gmail, obsidian, jira, social-media-manager).
- Ejemplo de config committeado (sin secretos): `docs/zcode-config.example.json`.
- Rama del run: `tasky/zcode-chrome-bridge`, HEAD limpio `094be3e` tras el amend que
  quitó `.auth/`, `.v2c/`, `.video_agent/`, `PLAN.md` del tracking inicial y añadió
  `EXECUTION_REPORT*.md` a `.gitignore`.

## Pendientes que quedaron
- [ ] Cargar `packages/extension/dist` como extensión desempaquetada en
      `chrome://extensions` (modo desarrollador).
- [ ] Reiniciar la sesión de ZCode para que recargue `~/.zcode/cli/config.json`.
- [ ] Verificar la conexión MCP real e invocar tools desde ZCode; correr
      `npm run smoke:live` con la extensión cargada.
- [ ] Decidir en un run posterior si el repo pasa de privado a público (revisar
      README y datos sensibles antes).

## Enlaces
- Doc en el repo (fuente de verdad): ../../PLAN.md
