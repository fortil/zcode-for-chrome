export interface ActionLogEntry {
  ts: number;
  tool: string;
  host: string;
  ok: boolean;
  code?: string;
}

const STORAGE_KEY = "actionLog";
const MAX_ENTRIES = 50;

// Las escrituras se serializan: con hasta 4 pestañas en paralelo, un
// read-modify-write libre sobre storage pierde entradas.
let writeChain: Promise<void> = Promise.resolve();

export function appendAction(entry: ActionLogEntry): Promise<void> {
  const next = writeChain.then(() => writeEntry(entry));
  writeChain = next.catch(() => undefined);
  return next;
}

async function writeEntry(entry: ActionLogEntry): Promise<void> {
  const stored = (await chrome.storage.session.get(STORAGE_KEY)) as Record<string, unknown>;
  const entries = Array.isArray(stored[STORAGE_KEY]) ? (stored[STORAGE_KEY] as ActionLogEntry[]) : [];
  entries.push(entry);
  await chrome.storage.session.set({ [STORAGE_KEY]: entries.slice(-MAX_ENTRIES) });
}

export async function getActions(limit = 20): Promise<ActionLogEntry[]> {
  const stored = (await chrome.storage.session.get(STORAGE_KEY)) as Record<string, unknown>;
  const entries = Array.isArray(stored[STORAGE_KEY]) ? (stored[STORAGE_KEY] as ActionLogEntry[]) : [];
  return entries.slice(-limit).reverse();
}
