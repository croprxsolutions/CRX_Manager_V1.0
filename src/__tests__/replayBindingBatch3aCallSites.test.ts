/**
 * Replay-binding batch 3a (migration 20261018230000): the five screens that call complete_delivery
 * or complete_job retire a refused retry key ONLY when the refusal proves nothing committed under it
 * ('intent' = the key belongs to a different request, 'actor' = to another user). A 'receipt'
 * refusal (IDEMPOTENCY_RESULT_INVALID / IDEMPOTENCY_RECEIPT_MISSING) must keep the key: an earlier
 * attempt may have committed, and the key is the only way to replay it instead of completing again.
 * Same rule and form as batches 1 and 2 (replayBindingBatch1CallSites.test.ts).
 *
 * After an 'intent' refusal the next click runs under a fresh key. If the first attempt had in fact
 * completed the delivery or job, that fresh call is refused by the body itself (the delivery or job
 * is no longer in_progress), so a retired key can never complete the same record twice.
 *
 * Each check names the screen's own key hook, so it counts only the completion call site and is
 * unaffected by other batches' sites in the same file (Deliveries.tsx also cancels deliveries).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// File -> the key hook of its completion call.
const SITES: Array<[string, string]> = [
  ['src/pages/Deliveries.tsx', 'completeIdem'],
  ['src/pages/DeliveryDetail.tsx', 'completeIdem'],
  ['src/pages/FieldStop.tsx', 'completeIdem'],
  ['src/pages/FieldView.tsx', 'completeIdem'],
  ['src/pages/JobDetail.tsx', 'completeJobIdem'],
];

const intentOrActorReset = (hook: string) => new RegExp(
  `const bindingRejection = getIdempotencyBindingRejection\\(\\w+\\);\\s*\\n\\s*if \\(bindingRejection === 'intent' \\|\\| bindingRejection === 'actor'\\) ${hook}\\.resetKey\\(\\);`,
  'g',
);
// Any reset guarded by the bare helper result (truthy for 'receipt' too).
const BARE_HELPER_RESET = /if\s*\(\s*getIdempotencyBindingRejection\([^)]*\)\s*\)\s*\{?\s*\S*reset\S*\(/;

const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

describe('replay-binding batch 3a call sites keep the key on a receipt refusal', () => {
  for (const [file, hook] of SITES) {
    it(`${file}: the completion retires ${hook} only for intent or actor`, () => {
      const source = read(file);
      expect(source.match(intentOrActorReset(hook))?.length ?? 0).toBe(1);
      expect(BARE_HELPER_RESET.test(source)).toBe(false);
    });
  }

  // After 20261018230000 both refuse a keyless call (IDEMPOTENCY_KEY_REQUIRED); the generated types
  // still mark the key optional, so pin that every app call sends one.
  const KEYED_CALLS: Array<[string, string]> = [
    ['src/pages/Deliveries.tsx', 'complete_delivery'],
    ['src/pages/DeliveryDetail.tsx', 'complete_delivery'],
    ['src/pages/FieldStop.tsx', 'complete_delivery'],
    ['src/pages/FieldView.tsx', 'complete_job'],
    ['src/pages/JobDetail.tsx', 'complete_job'],
  ];
  for (const [file, rpc] of KEYED_CALLS) {
    it(`${file}: every ${rpc} call sends p_idempotency_key`, () => {
      const source = read(file);
      // Inline argument objects run to their closing '})'; DeliveryDetail, FieldStop and FieldView
      // pass a named rpcParams object built just above the call.
      const inline = [...source.matchAll(new RegExp(`\\.rpc\\('${rpc}', \\{([\\s\\S]*?)\\n\\s*\\}\\)`, 'g'))];
      const named = [...source.matchAll(new RegExp(`\\.rpc\\('${rpc}', rpcParams\\)`, 'g'))];
      expect(inline.length + named.length).toBeGreaterThan(0);
      for (const call of inline) {
        expect(call[1]).toMatch(/p_idempotency_key:\s*\S/);
        expect(call[1]).not.toMatch(/p_idempotency_key:[^,\n]*\b(?:undefined|null)\b/);
      }
      if (named.length > 0) {
        const params = /const rpcParams[^=]*= \{([\s\S]*?)\n\s*\};/.exec(source);
        expect(params?.[1]).toMatch(/p_idempotency_key:\s*(?:idemKey|completeIdem\.getKey\(\))/);
      }
    });
  }

  it('JobDetail maps the refusal codes to plain English (PostgREST errors are not Error instances)', () => {
    const source = read('src/pages/JobDetail.tsx');
    expect(source).toContain('const completeMsg = sanitizeError(err);');
  });

  it('the patterns tell the two forms apart', () => {
    const good = "const bindingRejection = getIdempotencyBindingRejection(error);\n    if (bindingRejection === 'intent' || bindingRejection === 'actor') completeIdem.resetKey();";
    const bad = 'if (getIdempotencyBindingRejection(error)) completeIdem.resetKey();';
    expect(good.match(intentOrActorReset('completeIdem'))?.length).toBe(1);
    expect(BARE_HELPER_RESET.test(good)).toBe(false);
    expect(BARE_HELPER_RESET.test(bad)).toBe(true);
  });
});

// Both refuse a keyless call, so a browser test that leaves the key out fails once the migration is
// live. Every e2e call to one of them must send a key.
describe('replay-binding batch 3a e2e callers send a retry key', () => {
  const CALL = /(?:supabaseRpc|rpc)\(\s*page,\s*'(complete_delivery|complete_job)',\s*\{/g;
  const argsOf = (source: string, open: number) => {
    let depth = 1;
    let i = open;
    while (depth > 0 && i < source.length) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
      i++;
    }
    return source.slice(open, i);
  };
  const keylessCalls = (source: string) =>
    [...source.matchAll(CALL)].filter((m) => !/p_idempotency_key/.test(argsOf(source, m.index + m[0].length)));

  it('no e2e spec calls complete_delivery or complete_job without p_idempotency_key', () => {
    const specs = readdirSync('tests/e2e').filter((f) => f.endsWith('.ts'));
    let calls = 0;
    for (const spec of specs) {
      const source = read(`tests/e2e/${spec}`);
      calls += [...source.matchAll(CALL)].length;
      expect(keylessCalls(source).map((m) => `${spec}: ${m[1]}`)).toEqual([]);
    }
    expect(calls).toBeGreaterThanOrEqual(9);
  });

  it('the check tells a keyless call from a keyed one', () => {
    expect(keylessCalls("await supabaseRpc(page, 'complete_delivery', { p_delivery_id: d, p_quantities: { a: 1 } });")).toHaveLength(1);
    expect(keylessCalls("await supabaseRpc(page, 'complete_delivery', { p_quantities: { a: 1 }, p_idempotency_key: k });")).toHaveLength(0);
  });
});
