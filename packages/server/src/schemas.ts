import { z } from "zod";
import { BridgeError, LIMITS } from "@zcode-for-chrome/shared";
import type { ToolName } from "@zcode-for-chrome/shared";

const tabId = z
  .number()
  .int()
  .optional()
  .describe("ID de la pestaña; si se omite, la activa de la última ventana enfocada");
const ref = z
  .string()
  .optional()
  .describe("Referencia eN devuelta por snapshot o query_selector");
const selector = z.string().min(1).optional().describe("Selector CSS del elemento");

const bases = {
  browser_status: z.object({}),
  list_tabs: z.object({}),
  new_tab: z.object({
    url: z.string().optional().describe("URL inicial de la pestaña"),
    active: z.boolean().optional().default(true).describe("Si la pestaña se activa al abrirse"),
  }),
  activate_tab: z.object({
    tabId: z.number().int().describe("ID de la pestaña a activar"),
  }),
  close_tab: z.object({
    tabId: z.number().int().describe("ID de la pestaña a cerrar"),
  }),
  navigate: z.object({
    tabId,
    url: z.string().optional().describe("URL a la que navegar"),
    action: z
      .enum(["back", "forward", "reload"])
      .optional()
      .describe("Acción de historial en lugar de url"),
  }),
  wait_for: z.object({
    tabId,
    selector: selector.describe("Espera a que este selector exista"),
    text: z.string().optional().describe("Espera a que el texto aparezca en el body"),
    urlContains: z.string().optional().describe("Espera a que la URL contenga esta subcadena"),
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(LIMITS.maxWaitMs)
      .optional()
      .default(10000)
      .describe(`Tiempo máximo de espera en ms (máx ${LIMITS.maxWaitMs})`),
  }),
  get_page_content: z.object({
    tabId,
    selector: selector.describe("Limita el texto a este selector"),
    maxChars: z
      .number()
      .int()
      .min(100)
      .max(LIMITS.maxChars)
      .optional()
      .default(LIMITS.defaultChars)
      .describe(`Límite de caracteres devueltos (máx ${LIMITS.maxChars})`),
  }),
  snapshot: z.object({
    tabId,
    viewportOnly: z.boolean().optional().default(false).describe("Solo elementos visibles en el viewport"),
    maxElements: z
      .number()
      .int()
      .min(1)
      .max(LIMITS.maxElements)
      .optional()
      .default(LIMITS.defaultElements)
      .describe(`Máximo de elementos en el snapshot (máx ${LIMITS.maxElements})`),
  }),
  query_selector: z.object({
    tabId,
    selector: z.string().min(1).describe("Selector CSS a buscar"),
    limit: z.number().int().min(1).max(200).optional().default(20).describe("Máximo de resultados"),
  }),
  screenshot: z.object({
    tabId,
    format: z.enum(["jpeg", "png"]).optional().default("jpeg").describe("Formato de la captura"),
    quality: z.number().int().min(1).max(100).optional().default(80).describe("Calidad jpeg (1-100)"),
    maxWidth: z
      .number()
      .int()
      .min(100)
      .max(4096)
      .optional()
      .default(1280)
      .describe("Reescala la captura a este ancho máximo"),
    fullPage: z.boolean().optional().default(false).describe("Captura la página completa (CDP)"),
  }),
  click: z.object({
    tabId,
    ref,
    selector,
    button: z.enum(["left", "right", "middle"]).optional().default("left").describe("Botón del ratón"),
    clickCount: z
      .union([z.literal(1), z.literal(2)])
      .optional()
      .default(1)
      .describe("1 = click, 2 = doble click"),
    trusted: z
      .boolean()
      .optional()
      .default(false)
      .describe("true = click trusted por CDP (activa la barra de depuración)"),
  }),
  click_at: z.object({
    tabId,
    x: z.number().describe("Coordenada X del viewport en px"),
    y: z.number().describe("Coordenada Y del viewport en px"),
    button: z.enum(["left", "right", "middle"]).optional().default("left").describe("Botón del ratón"),
    clickCount: z.union([z.literal(1), z.literal(2)]).optional().default(1).describe("1 = click, 2 = doble click"),
  }),
  hover: z.object({
    tabId,
    ref,
    selector,
  }),
  fill: z.object({
    tabId,
    ref,
    selector,
    value: z.string().describe("Valor a escribir"),
    clear: z.boolean().optional().default(true).describe("Borra el valor actual antes de escribir"),
  }),
  select_option: z.object({
    tabId,
    ref,
    selector,
    value: z.string().optional().describe("value del <option> a seleccionar"),
    label: z.string().optional().describe("texto visible del <option> a seleccionar"),
  }),
  type_text: z.object({
    tabId,
    ref,
    selector,
    text: z.string().describe("Texto a escribir como teclado real"),
  }),
  press_key: z.object({
    tabId,
    key: z.string().describe("Tecla (Enter, Tab, a, F5, ...)"),
    modifiers: z
      .array(z.enum(["Alt", "Control", "Meta", "Shift"]))
      .optional()
      .describe("Modificadores a mantener pulsados"),
  }),
  scroll: z.object({
    tabId,
    direction: z.enum(["up", "down", "left", "right"]).optional().default("down").describe("Dirección del scroll"),
    amount: z.number().int().min(1).max(100000).optional().default(600).describe("Píxeles a desplazar"),
    ref,
    selector,
  }),
  evaluate_js: z.object({
    tabId,
    expression: z.string().min(1).describe("Expresión JS a evaluar en la página"),
    awaitPromise: z.boolean().optional().default(true).describe("Espera promesas devueltas"),
  }),
} satisfies Record<ToolName, z.ZodType>;

type Refinements = Partial<
  Record<ToolName, (value: Record<string, unknown>, ctx: z.RefinementCtx) => void>
>;

const exactlyOne = (a: string, b: string) => (value: Record<string, unknown>, ctx: z.RefinementCtx) => {
  if ((value[a] !== undefined) === (value[b] !== undefined)) {
    ctx.addIssue({ code: "custom", message: `indica exactamente uno de "${a}" o "${b}"` });
  }
};

const refinements: Refinements = {
  navigate: exactlyOne("url", "action"),
  click: exactlyOne("ref", "selector"),
  hover: exactlyOne("ref", "selector"),
  fill: exactlyOne("ref", "selector"),
  select_option: exactlyOne("ref", "selector"),
};

export const TOOL_SHAPES = {} as Record<ToolName, z.ZodRawShape>;
export const TOOL_VALIDATORS = {} as Record<ToolName, z.ZodType>;

for (const [name, base] of Object.entries(bases)) {
  const tool = name as ToolName;
  TOOL_SHAPES[tool] = (base as z.ZodObject<z.ZodRawShape>).shape;
  const refine = refinements[tool];
  TOOL_VALIDATORS[tool] = refine ? base.superRefine(refine) : base;
}

export function parseParams(tool: ToolName, args: unknown): Record<string, unknown> {
  const result = TOOL_VALIDATORS[tool].safeParse(args ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new BridgeError("INVALID_PARAMS", `${tool}: ${issues}`);
  }
  return result.data as Record<string, unknown>;
}
