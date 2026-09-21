// Funciones que se inyectan en la página con chrome.scripting.executeScript.
//
// D9: cada función exportada es AUTOCONTENIDA. executeScript serializa la
// función con toString() y en la página solo existe su propio cuerpo: cualquier
// referencia a helpers de este módulo o a identificadores del bundle sería un
// ReferenceError. Los inputs entran por `args` (JSON-serializables) y la
// lógica compartida (visibilidad, refs, eventos) se duplica dentro de cada
// función que la necesita. Este archivo no puede tener imports de valores
// (solo `import type`), y las funciones no pueden llamarse entre sí.

// Registro de refs en el mundo ISOLATED del frame principal (D4): una única
// global por frame y extensión, que sobrevive entre llamadas a executeScript
// mientras la página no navegue. `prev` conserva la generación anterior de
// refs para distinguir STALE_REF de ELEMENT_NOT_FOUND cuando el agente usa un
// ref corto de un snapshot ya reemplazado. Los refs completos (<snapId>e<n>)
// llevan el snapId embebido y se validan directamente contra zc.snapId.
interface Zc {
  snapId: string;
  refs: Map<string, Element>;
  prev: Map<string, Element> | null;
  next: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SnapshotResult {
  snapId: string;
  url: string;
  title: string;
  total: number;
  truncated: boolean;
  lines: string[];
}

export interface QueryItem {
  ref: string;
  tag: string;
  text: string;
  attributes: Record<string, string>;
  visible: boolean;
  rect: Rect;
}

export type QueryResult =
  | { items: QueryItem[] }
  | { items: QueryItem[]; error: "INVALID_PARAMS" };

export interface ContentResult {
  found: boolean;
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

export type ScrollResult =
  | { scrollX: number; scrollY: number }
  | { scrollX: number; scrollY: number; error: "ELEMENT_NOT_FOUND" | "STALE_REF" };

export interface ResolveResult {
  found: boolean;
  stale: boolean;
  rect?: Rect;
  tag?: string;
  text?: string;
}

export type FocusResult = { ok: true } | { ok: false; error: "ELEMENT_NOT_FOUND" | "STALE_REF" };

export type ActionErrorCode = "ELEMENT_NOT_FOUND" | "STALE_REF" | "INVALID_PARAMS";

export type ClickResult =
  | { ok: true; tag: string; text: string }
  | { ok: false; error: Exclude<ActionErrorCode, "INVALID_PARAMS"> };

export type FillResult =
  | { ok: true; tag: string; type: string; selectedValue?: string }
  | { ok: false; error: ActionErrorCode };

export type SelectResult =
  | { ok: true; selectedValue: string }
  | { ok: false; error: ActionErrorCode };

// snapshot: recorre los elementos interactivos visibles, les asigna refs
// e1..eN en un snapId nuevo y devuelve las líneas de texto de D7.9.
export function injSnapshot(arg: { viewportOnly: boolean; maxElements: number }): SnapshotResult {
  const anyGlobal = globalThis as any;
  const old = anyGlobal.__zc as Zc | undefined;
  const zc: Zc = {
    snapId: "s" + Date.now().toString(36),
    refs: new Map(),
    prev: old && old.refs ? old.refs : null,
    next: 1,
  };
  anyGlobal.__zc = zc;

  function visible(el: Element): boolean {
    const rects = el.getClientRects();
    if (!rects || rects.length === 0) return false;
    return window.getComputedStyle(el).visibility !== "hidden";
  }

  function inViewport(el: Element): boolean {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
  }

  function roleOf(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || role === "button") return "button";
    if (tag === "select" || role === "combobox" || role === "listbox") return "combobox";
    if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6" || role === "heading") {
      return "heading";
    }
    if (tag === "textarea" || role === "textbox" || (el as HTMLElement).isContentEditable) return "textbox";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    return "clickable";
  }

  function quote(text: string): string {
    return '"' + text.replace(/[\r\n\t]+/g, " ").replace(/"/g, '\\"') + '"';
  }

  // Orden de D7.9: aria-label → aria-labelledby → <label for> → innerText
  // (≤80) → placeholder → title → alt.
  function nameOf(el: Element): string {
    const aria = (el.getAttribute("aria-label") || "").trim();
    if (aria) return quote(aria.slice(0, 80));
    const labelledby = (el.getAttribute("aria-labelledby") || "").trim();
    if (labelledby) {
      const parts: string[] = [];
      for (const id of labelledby.split(/\s+/)) {
        const target = id ? document.getElementById(id) : null;
        const text = target ? (target.textContent || "").trim() : "";
        if (text) parts.push(text);
      }
      if (parts.length > 0) return quote(parts.join(" ").slice(0, 80));
    }
    const ownId = el.getAttribute("id");
    if (ownId) {
      let label: Element | null = null;
      try {
        label = document.querySelector('label[for="' + ownId.replace(/"/g, '\\"') + '"]');
      } catch {
        label = null;
      }
      const text = label ? (label.textContent || "").trim() : "";
      if (text) return quote(text.slice(0, 80));
    }
    const own = ((el as HTMLElement).innerText || "").trim();
    if (own) return quote(own.slice(0, 80));
    const placeholder = (el.getAttribute("placeholder") || "").trim();
    if (placeholder) return quote(placeholder.slice(0, 80));
    const title = (el.getAttribute("title") || "").trim();
    if (title) return quote(title.slice(0, 80));
    const alt = (el.getAttribute("alt") || "").trim();
    if (alt) return quote(alt.slice(0, 80));
    return quote("");
  }

  function attrsOf(el: Element): string {
    const parts: string[] = [];
    for (const key of ["id", "name", "type", "href", "placeholder"]) {
      const value = (el.getAttribute(key) || "").trim();
      if (value) parts.push(key + "=" + value.replace(/\s+/g, " ").slice(0, 80));
    }
    return parts.length > 0 ? " " + parts.join(" ") : "";
  }

  const nodes = Array.from(
    document.querySelectorAll(
      'a[href],button,input,select,textarea,[role],[contenteditable=""],[contenteditable=true],[onclick],[tabindex],h1,h2,h3,h4,h5,h6',
    ),
  );
  const lines: string[] = [];
  let total = 0;
  let truncated = false;
  for (const node of nodes) {
    const el = node as Element;
    if (!visible(el)) continue;
    if (arg.viewportOnly && !inViewport(el)) continue;
    if (lines.length >= arg.maxElements) {
      truncated = true;
      break;
    }
    total++;
    const ref = "e" + zc.next++;
    zc.refs.set(ref, el);
    lines.push("[" + ref + "] " + roleOf(el) + " " + nameOf(el) + attrsOf(el));
  }
  return {
    snapId: zc.snapId,
    url: location.href,
    title: document.title,
    total,
    truncated,
    lines,
  };
}

// query_selector: asigna refs bajo el snapId VIGENTE (creándolo si no hay)
// y describe cada match al estilo D7.10.
export function injQuery(arg: { selector: string; limit: number }): QueryResult {
  const anyGlobal = globalThis as any;
  let zc = anyGlobal.__zc as Zc | undefined;
  if (!zc || !zc.refs) {
    zc = { snapId: "s" + Date.now().toString(36), refs: new Map(), prev: null, next: 1 };
    anyGlobal.__zc = zc;
  }

  let nodes: NodeListOf<Element>;
  try {
    nodes = document.querySelectorAll(arg.selector);
  } catch {
    return { items: [], error: "INVALID_PARAMS" };
  }

  function visible(el: Element): boolean {
    const rects = el.getClientRects();
    if (!rects || rects.length === 0) return false;
    return window.getComputedStyle(el).visibility !== "hidden";
  }

  const items: QueryItem[] = [];
  for (const node of Array.from(nodes)) {
    if (items.length >= arg.limit) break;
    const el = node as Element;
    let ref = "";
    for (const entry of Array.from(zc.refs.entries())) {
      if (entry[1] === el) {
        ref = entry[0];
        break;
      }
    }
    if (!ref) {
      ref = "e" + zc.next++;
      zc.refs.set(ref, el);
    }
    const r = el.getBoundingClientRect();
    const attributes: Record<string, string> = {};
    for (const key of ["id", "class", "name", "href", "value", "type", "placeholder", "ariaLabel", "role"]) {
      let value = "";
      if (key === "value") {
        const prop = (el as HTMLInputElement).value;
        value = typeof prop === "string" ? prop.trim() : "";
      } else {
        value = (el.getAttribute(key === "ariaLabel" ? "aria-label" : key) || "").trim();
      }
      if (value) attributes[key] = value.slice(0, 200);
    }
    items.push({
      ref,
      tag: el.tagName.toLowerCase(),
      text: ((el as HTMLElement).innerText || el.textContent || "").trim().slice(0, 200),
      attributes,
      visible: visible(el),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    });
  }
  return { items };
}

// get_page_content: innerText del selector o del body, con tope de caracteres.
export function injContent(arg: { selector?: string; maxChars: number }): ContentResult {
  let el: Element | null = null;
  if (arg.selector) {
    try {
      el = document.querySelector(arg.selector);
    } catch {
      el = null;
    }
  } else {
    el = document.body;
  }
  if (!el) {
    return { found: false, url: location.href, title: document.title, text: "", truncated: false };
  }
  const full = (el as HTMLElement).innerText || el.textContent || "";
  const text = full.slice(0, arg.maxChars);
  return {
    found: true,
    url: location.href,
    title: document.title,
    text,
    truncated: full.length > text.length,
  };
}

// scroll: scrollIntoView si hay ref/selector; si no, window.scrollBy según
// dirección y cantidad.
export function injScroll(arg: { direction: string; amount: number; ref?: string; selector?: string }): ScrollResult {
  if (arg.ref || arg.selector) {
    // Resolución de elemento (duplicada de injResolve: D9).
    const anyGlobal = globalThis as any;
    const zc = anyGlobal.__zc as Zc | undefined;
    let el: Element | null = null;
    let stale = false;
    if (arg.ref) {
      const full = /^(s[0-9a-z]+)e([0-9]+)$/.exec(arg.ref);
      if (full) {
        if (!zc || zc.snapId !== full[1]) stale = true;
        else el = zc.refs.get("e" + full[2]) ?? null;
      } else if (zc && zc.refs.has(arg.ref)) {
        el = zc.refs.get(arg.ref) as Element;
      } else if (zc && zc.prev && zc.prev.has(arg.ref)) {
        stale = true;
      }
    }
    if (!el && arg.selector && !stale) {
      try {
        el = document.querySelector(arg.selector);
      } catch {
        el = null;
      }
    }
    if (!el) {
      return { scrollX: window.scrollX, scrollY: window.scrollY, error: stale ? "STALE_REF" : "ELEMENT_NOT_FOUND" };
    }
    (el as HTMLElement).scrollIntoView({ block: "center" });
    return { scrollX: window.scrollX, scrollY: window.scrollY };
  }
  const dx = arg.direction === "left" ? -arg.amount : arg.direction === "right" ? arg.amount : 0;
  const dy = arg.direction === "up" ? -arg.amount : arg.direction === "down" ? arg.amount : 0;
  window.scrollBy(dx, dy);
  return { scrollX: window.scrollX, scrollY: window.scrollY };
}

// Localización de elemento por ref o selector, para las tools de los pasos 12+
// (click trusted, hover) que solo necesitan el rect.
export function injResolve(arg: { ref?: string; selector?: string }): ResolveResult {
  const anyGlobal = globalThis as any;
  const zc = anyGlobal.__zc as Zc | undefined;
  let el: Element | null = null;
  let stale = false;
  if (arg.ref) {
    // Ref completo "<snapId>e<n>": el snapId va embebido y se valida contra
    // el vigente; si difiere, el ref es de otro snapshot.
    const full = /^(s[0-9a-z]+)e([0-9]+)$/.exec(arg.ref);
    if (full) {
      if (!zc || zc.snapId !== full[1]) stale = true;
      else el = zc.refs.get("e" + full[2]) ?? null;
    } else if (zc && zc.refs.has(arg.ref)) {
      el = zc.refs.get(arg.ref) as Element;
    } else if (zc && zc.prev && zc.prev.has(arg.ref)) {
      // Ref corto de la generación anterior: el snapshot fue reemplazado.
      stale = true;
    }
  }
  if (!el && arg.selector && !stale) {
    try {
      el = document.querySelector(arg.selector);
    } catch {
      el = null;
    }
  }
  if (!el) return { found: false, stale };
  const r = el.getBoundingClientRect();
  return {
    found: true,
    stale: false,
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    tag: el.tagName.toLowerCase(),
    text: ((el as HTMLElement).innerText || el.textContent || "").trim().slice(0, 200),
  };
}

// click DOM (D7.12): scrollIntoView + el.click() para left con clickCount 1,
// contextmenu para right, dblclick para clickCount 2 y secuencia
// pointer/mouse para el resto. trusted:true NO pasa por aquí: va por CDP.
export function injClick(arg: { ref?: string; selector?: string; button: string; clickCount: number }): ClickResult {
  // Resolución de elemento (duplicada de injResolve: D9).
  const anyGlobal = globalThis as any;
  const zc = anyGlobal.__zc as Zc | undefined;
  let el: Element | null = null;
  let stale = false;
  if (arg.ref) {
    const full = /^(s[0-9a-z]+)e([0-9]+)$/.exec(arg.ref);
    if (full) {
      if (!zc || zc.snapId !== full[1]) stale = true;
      else el = zc.refs.get("e" + full[2]) ?? null;
    } else if (zc && zc.refs.has(arg.ref)) {
      el = zc.refs.get(arg.ref) as Element;
    } else if (zc && zc.prev && zc.prev.has(arg.ref)) {
      stale = true;
    }
  }
  if (!el && arg.selector && !stale) {
    try {
      el = document.querySelector(arg.selector);
    } catch {
      el = null;
    }
  }
  if (!el) {
    return { ok: false, error: stale ? "STALE_REF" : "ELEMENT_NOT_FOUND" };
  }
  const target = el as HTMLElement;
  target.scrollIntoView({ block: "center", inline: "center" });
  const rect = target.getBoundingClientRect();
  const buttonCode = arg.button === "right" ? 2 : arg.button === "middle" ? 1 : 0;
  const mouseInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: rect.x + rect.width / 2,
    clientY: rect.y + rect.height / 2,
    button: buttonCode,
  };
  if (arg.clickCount === 2) {
    target.dispatchEvent(new MouseEvent("dblclick", mouseInit));
  } else if (arg.button === "left") {
    target.click();
  } else if (arg.button === "right") {
    target.dispatchEvent(new MouseEvent("contextmenu", mouseInit));
  } else {
    target.dispatchEvent(new MouseEvent("pointerdown", mouseInit));
    target.dispatchEvent(new MouseEvent("mousedown", mouseInit));
    target.dispatchEvent(new MouseEvent("pointerup", mouseInit));
    target.dispatchEvent(new MouseEvent("mouseup", mouseInit));
    target.dispatchEvent(new MouseEvent("click", mouseInit));
  }
  return {
    ok: true,
    tag: target.tagName.toLowerCase(),
    text: (target.innerText || target.textContent || "").trim().slice(0, 200),
  };
}

// fill (D7.15): input/textarea con el setter nativo del prototipo + eventos
// input y change (así React/Vue detectan el cambio); contenteditable con
// textContent + input; select con el mismo camino que injSelect.
export function injFill(arg: { ref?: string; selector?: string; value: string; clear: boolean }): FillResult {
  // Resolución de elemento (duplicada de injResolve: D9).
  const anyGlobal = globalThis as any;
  const zc = anyGlobal.__zc as Zc | undefined;
  let el: Element | null = null;
  let stale = false;
  if (arg.ref) {
    const full = /^(s[0-9a-z]+)e([0-9]+)$/.exec(arg.ref);
    if (full) {
      if (!zc || zc.snapId !== full[1]) stale = true;
      else el = zc.refs.get("e" + full[2]) ?? null;
    } else if (zc && zc.refs.has(arg.ref)) {
      el = zc.refs.get(arg.ref) as Element;
    } else if (zc && zc.prev && zc.prev.has(arg.ref)) {
      stale = true;
    }
  }
  if (!el && arg.selector && !stale) {
    try {
      el = document.querySelector(arg.selector);
    } catch {
      el = null;
    }
  }
  if (!el) {
    return { ok: false, error: stale ? "STALE_REF" : "ELEMENT_NOT_FOUND" };
  }
  const tag = el.tagName.toLowerCase();

  function notify(element: Element, withChange: boolean): void {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    if (withChange) element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setNativeValue(kind: "input" | "textarea", element: Element, next: string): void {
    const proto = kind === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && descriptor.set) descriptor.set.call(element, next);
    else (element as HTMLInputElement).value = next;
  }

  if (tag === "select") {
    let opt: Element | null = null;
    for (const option of Array.from(el.querySelectorAll("option"))) {
      if ((option as HTMLOptionElement).value === arg.value) {
        opt = option;
        break;
      }
    }
    if (!opt) return { ok: false, error: "ELEMENT_NOT_FOUND" };
    const select = el as HTMLSelectElement;
    select.focus();
    select.value = (opt as HTMLOptionElement).value;
    notify(el, true);
    return { ok: true, tag, type: "select", selectedValue: select.value };
  }
  if (tag === "textarea") {
    const base = arg.clear ? arg.value : (el as HTMLTextAreaElement).value + arg.value;
    (el as HTMLTextAreaElement).focus();
    setNativeValue("textarea", el, base);
    notify(el, true);
    return { ok: true, tag, type: "textarea" };
  }
  if (tag === "input") {
    const input = el as HTMLInputElement;
    const type = (input.getAttribute("type") || "text").toLowerCase();
    const editable = [
      "text",
      "email",
      "password",
      "search",
      "tel",
      "url",
      "number",
      "date",
      "datetime-local",
      "month",
      "time",
      "week",
      "color",
    ].indexOf(type);
    if (editable < 0) return { ok: false, error: "INVALID_PARAMS" };
    const base = arg.clear ? arg.value : input.value + arg.value;
    input.focus();
    setNativeValue("input", input, base);
    notify(el, true);
    return { ok: true, tag, type };
  }
  if ((el as HTMLElement).isContentEditable) {
    const current = arg.clear ? "" : el.textContent || "";
    (el as HTMLElement).focus();
    el.textContent = current + arg.value;
    notify(el, false);
    return { ok: true, tag, type: "contenteditable" };
  }
  return { ok: false, error: "INVALID_PARAMS" };
}

// select_option (D7.16): busca la opción por value o label, asigna
// select.value y dispara input+change.
export function injSelect(arg: { ref?: string; selector?: string; value?: string; label?: string }): SelectResult {
  // Resolución de elemento (duplicada de injResolve: D9).
  const anyGlobal = globalThis as any;
  const zc = anyGlobal.__zc as Zc | undefined;
  let el: Element | null = null;
  let stale = false;
  if (arg.ref) {
    const full = /^(s[0-9a-z]+)e([0-9]+)$/.exec(arg.ref);
    if (full) {
      if (!zc || zc.snapId !== full[1]) stale = true;
      else el = zc.refs.get("e" + full[2]) ?? null;
    } else if (zc && zc.refs.has(arg.ref)) {
      el = zc.refs.get(arg.ref) as Element;
    } else if (zc && zc.prev && zc.prev.has(arg.ref)) {
      stale = true;
    }
  }
  if (!el && arg.selector && !stale) {
    try {
      el = document.querySelector(arg.selector);
    } catch {
      el = null;
    }
  }
  if (!el) {
    return { ok: false, error: stale ? "STALE_REF" : "ELEMENT_NOT_FOUND" };
  }
  if (el.tagName.toLowerCase() !== "select") return { ok: false, error: "INVALID_PARAMS" };
  const select = el as HTMLSelectElement;
  let opt: Element | null = null;
  if (typeof arg.value === "string") {
    for (const option of Array.from(el.querySelectorAll("option"))) {
      if ((option as HTMLOptionElement).value === arg.value) {
        opt = option;
        break;
      }
    }
  }
  if (!opt && typeof arg.label === "string") {
    for (const option of Array.from(el.querySelectorAll("option"))) {
      if ((option.textContent || "").trim() === arg.label.trim()) {
        opt = option;
        break;
      }
    }
  }
  if (!opt) return { ok: false, error: "ELEMENT_NOT_FOUND" };
  select.focus();
  select.value = (opt as HTMLOptionElement).value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, selectedValue: select.value };
}

// type_text (D7.17): enfoca el elemento por ref/selector antes de que la capa
// CDP inserte el texto con Input.insertText.
export function injFocus(arg: { ref?: string; selector?: string }): FocusResult {
  // Resolución de elemento (duplicada de injResolve: D9).
  const anyGlobal = globalThis as any;
  const zc = anyGlobal.__zc as Zc | undefined;
  let el: Element | null = null;
  let stale = false;
  if (arg.ref) {
    const full = /^(s[0-9a-z]+)e([0-9]+)$/.exec(arg.ref);
    if (full) {
      if (!zc || zc.snapId !== full[1]) stale = true;
      else el = zc.refs.get("e" + full[2]) ?? null;
    } else if (zc && zc.refs.has(arg.ref)) {
      el = zc.refs.get(arg.ref) as Element;
    } else if (zc && zc.prev && zc.prev.has(arg.ref)) {
      stale = true;
    }
  }
  if (!el && arg.selector && !stale) {
    try {
      el = document.querySelector(arg.selector);
    } catch {
      el = null;
    }
  }
  if (!el) return { ok: false, error: stale ? "STALE_REF" : "ELEMENT_NOT_FOUND" };
  (el as HTMLElement).focus();
  return { ok: true };
}
