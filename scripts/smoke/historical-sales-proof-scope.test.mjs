import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const delivery = readFileSync(path.join(ROOT, 'scripts/smoke/prove-delivery-invoice-cap-real-schema.mjs'), 'utf8');
const quote = readFileSync(path.join(ROOT, 'scripts/smoke/prove-quote-pricing-real-schema.mjs'), 'utf8');
const smoke = readFileSync(path.join(ROOT, 'scripts/smoke/fixtures/quote-sent-price-lock-candidate-era.sql'), 'utf8');
const sharedSmoke = readFileSync(path.join(ROOT, 'scripts/smoke/smoke-quote-sent-price-lock.sql'), 'utf8');

assert.match(delivery, /candidateIndex\s*=\s*all\.indexOf\(CAP\)/);
assert.match(delivery, /all\.slice\(0, candidateIndex\)/);
assert.match(delivery, /20261007150200_release_reservations_of_deleted_spring_orders first/);
assert.match(delivery, /DELIVERY_INVOICE_CAP_PROOF_PASS/);

assert.match(quote, /HISTORICAL CANDIDATE-ERA PROOF ONLY/);
assert.match(quote, /all\.slice\(0, at\)/);
assert.match(quote, /assert\.deepEqual\(new Set\(suffixMatches\), EXPECTED_SUFFIX_MATCHES/);
assert.match(quote, /unknown args:/);
assert.match(quote, /QUOTE_PRICING_CHEMICAL_SALES_PROOF_PASS/);
assert.match(quote, /CHEMICAL_SALES_EXCLUDED_MUTATIONS\.has\(label\)/);
assert.match(quote, /CHEMICAL_SALES_EXCLUDED_REGRESSION\.has\(chain\)/);
assert.match(quote, /file === 'smoke-quote-sent-price-lock\.sql'/);
assert.match(quote, /F\/G job scheduling excluded/);
assert.match(smoke, /Frozen from f1503ba91/);
assert.match(smoke, /expires_at FROM quotes[^\n]+IS DISTINCT FROM v_today \+ 15/);
assert.doesNotMatch(smoke, /v_season_end/);
assert.match(sharedSmoke, /v_season_end/);
assert.doesNotMatch(sharedSmoke, /CHEMICAL-SALES-EXCLUDED/);

const start = '-- BEGIN CHEMICAL-SALES-EXCLUDED: JOB SCHEDULING CASES F/G';
const end = '-- END CHEMICAL-SALES-EXCLUDED: JOB SCHEDULING CASES F/G';
assert.equal(smoke.split(start).length - 1, 1, 'quote smoke must have one chemical scope start marker');
assert.equal(smoke.split(end).length - 1, 1, 'quote smoke must have one chemical scope end marker');
const scoped = smoke.slice(smoke.indexOf(start), smoke.indexOf(end));
assert.match(scoped, /SMOKE_FAIL: \(G\) scheduling a job/);
assert.match(scoped, /SMOKE_FAIL: \(F\) the never-sent planned draft/);
assert.doesNotMatch(smoke.slice(0, smoke.indexOf(start)), /SMOKE_FAIL: \([FG]\)/);
assert.doesNotMatch(smoke.slice(smoke.indexOf(end) + end.length), /SMOKE_FAIL: \([FG]\)/);

console.log('historical sales proof scope checks passed');
