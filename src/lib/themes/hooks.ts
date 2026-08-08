/**
 * WordPress-style hooks registry.
 *
 * Two flavors:
 *   - Filters transform a value: `applyFilters('the_content', html, ctx)` —
 *     each registered filter receives the running value and returns a new one.
 *   - Actions run side effects: `doAction('post_rendered', ctx)` —
 *     each registered action runs in priority order; return values are ignored.
 *
 * Hooks are wired by core only — we never dynamically import JS from uploaded
 * theme zips (that would be RCE-by-design). A future plugin loader can register
 * more, under its own threat model.
 */

type FilterFn<T> = (value: T, ctx?: unknown) => T | Promise<T>;
type ActionFn = (ctx?: unknown) => void | Promise<void>;

type Registration<F> = { fn: F; priority: number };

const filters = new Map<string, Registration<FilterFn<unknown>>[]>();
const actions = new Map<string, Registration<ActionFn>[]>();

/** Register a filter. Lower priorities run first (WordPress semantics). */
export function addFilter<T>(name: string, fn: FilterFn<T>, priority = 10): void {
  const list = filters.get(name) ?? [];
  list.push({ fn: fn as FilterFn<unknown>, priority });
  list.sort((a, b) => a.priority - b.priority);
  filters.set(name, list);
}

/** Run every filter for `name` over `value` in priority order; returns the result. */
export async function applyFilters<T>(name: string, value: T, ctx?: unknown): Promise<T> {
  const list = filters.get(name);
  if (!list || list.length === 0) return value;
  let current: unknown = value;
  for (const { fn } of list) {
    current = await fn(current, ctx);
  }
  return current as T;
}

/** Register a side-effect action. Priority semantics mirror `addFilter`. */
export function addAction(name: string, fn: ActionFn, priority = 10): void {
  const list = actions.get(name) ?? [];
  list.push({ fn, priority });
  list.sort((a, b) => a.priority - b.priority);
  actions.set(name, list);
}

/** Fire every registered action for `name`. Errors propagate to the caller. */
export async function doAction(name: string, ctx?: unknown): Promise<void> {
  const list = actions.get(name);
  if (!list) return;
  for (const { fn } of list) await fn(ctx);
}

/** Test/debug helper — not used by the renderer. */
export function _resetHooks(): void {
  filters.clear();
  actions.clear();
}