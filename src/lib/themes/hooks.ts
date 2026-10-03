// Registered by core code only — never load JS from uploaded theme zips (RCE).

type FilterFn<T> = (value: T, ctx?: unknown) => T | Promise<T>;
type ActionFn = (ctx?: unknown) => void | Promise<void>;

type Registration<F> = { fn: F; priority: number };

const filters = new Map<string, Registration<FilterFn<unknown>>[]>();
const actions = new Map<string, Registration<ActionFn>[]>();

export function addFilter<T>(name: string, fn: FilterFn<T>, priority = 10): void {
  const list = filters.get(name) ?? [];
  list.push({ fn: fn as FilterFn<unknown>, priority });
  list.sort((a, b) => a.priority - b.priority);
  filters.set(name, list);
}

export async function applyFilters<T>(name: string, value: T, ctx?: unknown): Promise<T> {
  const list = filters.get(name);
  if (!list || list.length === 0) return value;
  let current: unknown = value;
  for (const { fn } of list) {
    current = await fn(current, ctx);
  }
  return current as T;
}

export function addAction(name: string, fn: ActionFn, priority = 10): void {
  const list = actions.get(name) ?? [];
  list.push({ fn, priority });
  list.sort((a, b) => a.priority - b.priority);
  actions.set(name, list);
}

export async function doAction(name: string, ctx?: unknown): Promise<void> {
  const list = actions.get(name);
  if (!list) return;
  for (const { fn } of list) await fn(ctx);
}

export function _resetHooks(): void {
  filters.clear();
  actions.clear();
}