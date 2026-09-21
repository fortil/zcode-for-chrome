import { BridgeError, PROTECTED_HOSTS, PROTECTED_SCHEMES } from "@zcode-for-chrome/shared";

// Módulo PURO, sin APIs del navegador: se ejecuta tal cual en Node con
// --experimental-strip-types (verificación del Paso 8) y lo comparten el
// service worker y el popup.

export interface PolicySettings {
  enabled: boolean;
  blockedHosts: string[];
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isProtectedUrl(url: string): boolean {
  const lower = url.trim().toLowerCase();
  // PROTECTED_SCHEMES trae el esquema con los dos puntos ("chrome:"), así que
  // un startsWith por entrada cubre chrome://, about:blank y similares.
  for (const scheme of PROTECTED_SCHEMES) {
    if (lower.startsWith(scheme)) return true;
  }
  const host = hostnameOf(url);
  if (host === null) return false;
  return PROTECTED_HOSTS.some((protectedHost) => host === protectedHost || host.endsWith("." + protectedHost));
}

export function matchesBlockedHost(url: string, patterns: string[]): boolean {
  const host = hostnameOf(url);
  if (host === null) return false;
  return patterns.some((raw) => {
    const pattern = raw.trim().toLowerCase();
    if (pattern === "") return false;
    if (pattern.startsWith("*.")) {
      // "*.banco.com" cubre subdominios, no el dominio pelado.
      const base = pattern.slice(2);
      return base !== "" && host.endsWith("." + base);
    }
    return host === pattern;
  });
}

// Orden de verificación: interruptor global, páginas protegidas, hosts
// bloqueados. Devuelve el error que debe responderse, o null si la URL pasa.
export function checkPolicy(url: string, settings: PolicySettings): BridgeError | null {
  if (!settings.enabled) {
    return new BridgeError("EXT_DISABLED", "la extensión está desactivada desde el popup");
  }
  if (isProtectedUrl(url)) {
    return new BridgeError("PROTECTED_PAGE", `página protegida por la política de la extensión: ${url}`);
  }
  if (matchesBlockedHost(url, settings.blockedHosts)) {
    return new BridgeError("BLOCKED_HOST", `host bloqueado en los ajustes de la extensión: ${url}`);
  }
  return null;
}
