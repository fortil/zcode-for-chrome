// Cola por pestaña: los comandos sobre una misma pestaña se serializan y
// como mucho MAX_PARALLEL_TABS pestañas tienen un comando en vuelo a la vez
// (S6). El resto espera en una cola global.
const chains = new Map<number, Promise<unknown>>();
const waiting: Array<() => void> = [];
let active = 0;
const MAX_PARALLEL_TABS = 4;

function acquireSlot(): Promise<void> {
  if (active < MAX_PARALLEL_TABS) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiting.push(() => {
      active++;
      resolve();
    });
  });
}

function releaseSlot(): void {
  active--;
  const next = waiting.shift();
  if (next) next();
}

export function runInTabQueue<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(tabId) ?? Promise.resolve();
  const task = prev
    .then(() => acquireSlot())
    .then(() => fn())
    .finally(releaseSlot);
  const tail = task.then(
    () => undefined,
    () => undefined,
  );
  chains.set(tabId, tail);
  // Limpieza de la entrada cuando es la última de su pestaña, para no acumular
  // promesas por pestañas cerradas.
  void tail.then(() => {
    if (chains.get(tabId) === tail) chains.delete(tabId);
  });
  return task;
}
