import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { tier, dirtyStates } = vi.hoisted(() => ({ tier: { value: '1' }, dirtyStates: [] as boolean[] }));

function query(data: unknown) {
  const chain: Record<string, unknown> = {};
  for (const name of ['eq', 'neq', 'is', 'in', 'gt', 'order', 'limit', 'single', 'maybeSingle', 'select']) chain[name] = () => chain;
  const promise = new Promise((resolve) => setTimeout(() => resolve({ data, error: null }), 20));
  chain.then = promise.then.bind(promise);
  return chain;
}

vi.mock('../lib/db', async () => ({
  supabase: {
    from: (table: string) => query(table === 'app_settings' ? { setting_value: tier.value } : []),
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
  },
  assertRpcResult: (data: unknown) => data,
  checkMutationResult: vi.fn(),
  hasRpcCode: () => false,
  RpcErrorCodes: {},
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'admin-1', role: 'admin', full_name: 'Admin' } }) }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: (dirty: boolean) => { dirtyStates.push(dirty); return { state: 'unblocked', reset: vi.fn(), proceed: vi.fn() }; },
}));

import CustomerDetail from './CustomerDetail';

const realSetTimeout = globalThis.setTimeout;
let root: Root | null = null;

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root?.unmount();
  root = null;
});

describe('blank /customers/new', () => {
  // In a browser the 0ms timer that arms change tracking can fire before React's scheduled
  // re-render of the mount-time reset. act() hides that by flushing every render first, so
  // this renders outside act() and runs 0ms timers as microtasks to force the order.
  it.each(['1', '2'])('never reports unsaved changes with Default Tier %s when the timer beats the reset render', async (value) => {
    tier.value = value;
    dirtyStates.length = 0;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => (
      ms === 0 ? (queueMicrotask(fn), 0) : realSetTimeout(fn, ms, ...rest)
    )) as unknown as typeof setTimeout;

    root = createRoot(document.body.appendChild(document.createElement('div')));
    root.render(
      <MemoryRouter initialEntries={['/customers/new']}>
        <Routes><Route path="/customers/:id" element={<CustomerDetail />} /></Routes>
      </MemoryRouter>,
    );
    await new Promise((resolve) => realSetTimeout(resolve, 300));

    expect(dirtyStates.length).toBeGreaterThan(1); // it rendered and settled
    expect(dirtyStates).not.toContain(true);
  });
});
