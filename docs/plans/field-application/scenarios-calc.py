# Reference calculator for SCENARIOS.md: exact decimals, whole cents, no floating point.
#   python -I scenarios-calc.py          prints the tables
#   python -I scenarios-calc.py --check  fails if SCENARIOS.md tables differ from the printed ones
# Rules (SCENARIOS.md "Rules the numbers follow"; Mason 2026-11-24: "billing logic and rounding matches chemical sales"):
#   1. Each product is priced ONCE per job: its total quantity x price, rounded half up to whole cents once, so a job
#      never bills more or less than gallons x price. Service and fuel: total sprayed acres x rate, rounded once.
#      Product quantity on a field = sum over the loads that sprayed it of (load rate fl oz/acre x acres from that load / 128).
#   2. That job total is shared across the fields by quantity (acres for service and fuel) with the chemical-sale rule:
#      every field but the taker gets its exact part rounded down; the taker (the field with the most, ties to the
#      earlier field in spray order) gets the rest.
#   3. Each field line is shared across its payers with the chemical-sale rule (_bill_split_line_shares, live since
#      2026-11-09): every payer but the main customer gets their exact share rounded down; the main customer (the job's
#      customer) gets the rest; if the main customer has 0% on that line, the largest share gets it (live ties: lowest
#      customer id; payer order stands in for it here). Credits, as live: every other share floors away from zero.
import io
import re
import sys
from decimal import Decimal as D
from fractions import Fraction as F
import math

MICRO = 100_000_000
MAIN = 'P1'   # the job's customer (the grower)


def cents(x):
    """Exact rational in, whole cents out, half up (away from zero). Never rounds an intermediate value."""
    x = F(x)
    sign = -1 if x < 0 else 1
    return sign * math.floor(abs(x) + F(1, 2))


def take_rest(total, weights, taker):
    """weights: {key: non-negative exact weight}. Everyone but the taker gets their exact part rounded down."""
    w_all = sum(weights.values())
    assert w_all > 0 and weights[taker] > 0
    out = {k: math.floor(F(total) * F(w) / w_all) for k, w in weights.items() if k != taker}
    out[taker] = total - sum(out.values())
    assert out[taker] * total >= 0
    return out


def split(total, shares, main=MAIN):
    """shares: list of (payer, micro_pct) in payer order. Chemical-sale rule (rule 3)."""
    assert all(isinstance(s, int) and 0 <= s <= MICRO for _, s in shares), shares
    assert sum(s for _, s in shares) == MICRO, shares
    assert len({p for p, _ in shares}) == len(shares), shares
    sh = dict(shares)
    order = [p for p, _ in shares]
    taker = main if sh.get(main, 0) > 0 else max(order, key=lambda p: (sh[p], -order.index(p)))
    out = take_rest(total, sh, taker)
    assert sum(out.values()) == total
    return out


def by_field(total, weights):
    """Rule 2: weights in spray order; the taker is the biggest, ties to the earlier field."""
    keys = list(weights)
    taker = max(keys, key=lambda k: (weights[k], -keys.index(k)))
    return take_rest(total, weights, taker)


def pct(*ps):
    return [(p, int(D(v) * MICRO / 100)) for p, v in ps]


def show(q):
    return format((D(q.numerator) / D(q.denominator)).quantize(D('0.0001')).normalize(), 'f')


THIRDS = [('P1', 33_333_334), ('P2', 33_333_333), ('P3', 33_333_333)]
FIELDS = {'A': pct(('P1', 100)), 'B': pct(('P1', 50), ('P2', 50)), 'C': THIRDS}
PRICE = {'X': 4137, 'Y': 2319}   # made-up cents per gallon
SVC, FUEL = 875, 65              # made-up cents per acre


def job(work, prod_shares=FIELDS, app_shares=None):
    """work: list of (field, load_id, product, rate_floz_per_acre, acres), in spray order."""
    fields = list(dict.fromkeys(w[0] for w in work))
    qty = {}   # product -> {field: gallons}
    acres = {f: F(0) for f in fields}
    for f, l, p, r, a in work:
        qty.setdefault(p, {})
        qty[p][f] = qty[p].get(f, F(0)) + F(r) * F(a) / 128
        acres[f] += F(a)
    line = {}  # (field, line name) -> (qty text, cents)
    for p, per_field in qty.items():
        c = by_field(cents(sum(per_field.values()) * PRICE[p]), per_field)
        for f in per_field:
            line[(f, p)] = (f'{show(per_field[f])} gal', c[f])
    for name, rate in (('Service', SVC), ('Fuel', FUEL)):
        c = by_field(cents(sum(acres.values()) * rate), acres)
        for f in fields:
            line[(f, name)] = (f'{show(acres[f])} ac', c[f])
    rows = []
    for f in fields:
        for p in qty:
            if f in qty[p]:
                rows.append((f, p) + line[(f, p)] + (prod_shares[f],))
        for name in ('Service', 'Fuel'):
            rows.append((f, name) + line[(f, name)] + ((app_shares or prod_shares)[f],))
    return rows


def table(rows):
    lines = ['| Field | Line | Qty | Field total (cents) | P1 | P2 | P3 |', '|---|---|---|---|---|---|---|']
    tot = {'P1': 0, 'P2': 0, 'P3': 0}
    grand = 0
    for f, name, q, amt, sh in rows:
        s = split(amt, sh)
        grand += amt
        for p in s:
            tot[p] += s[p]
        lines.append(f'| {f} | {name} | {q} | {amt} | ' + ' | '.join(str(s[p]) if p in s else '-' for p in ('P1', 'P2', 'P3')) + ' |')
    assert sum(tot.values()) == grand
    lines.append(f'| **Total** | | | **{grand}** | **{tot["P1"]}** | **{tot["P2"]}** | **{tot["P3"]}** |')
    return '\n'.join(lines), tot, grand


STD = [('A', 'L1', 'X', 32, 49), ('B', 'L1', 'X', 32, 110), ('C', 'L1', 'X', 32, 69)]
s6 = job(STD)
s6[3] = s6[3][:4] + (pct(('P1', 100), ('P2', 0)),)
S4B = [('A', 'L1', 'X', 32, 49), ('B', 'L1', 'X', 32, 40), ('B', 'L2', 'Y', 24, 70), ('C', 'L2', 'Y', 24, 69)]
TABLES = {
    'S1': table(job(STD)),
    'S2': table(job([('A', 'L1', 'X', 32, 49), ('B', 'L1', 'X', 32, 110), ('C', 'L1', 'X', 32, '68.7')])),
    'S3': table(job(STD, app_shares={'A': pct(('P1', 100)), 'B': pct(('P1', 100), ('P2', 0)), 'C': pct(('P1', 50), ('P2', 50), ('P3', 0))})),
    'S4': table(job([('A', 'L1', 'X', 32, 49), ('B', 'L2', 'Y', 24, 110), ('C', 'L2', 'Y', 24, 69)])),
    'S4b': table(job(S4B)),
    'S6': table(s6),
    'S9': table(job(STD, prod_shares={'A': pct(('P1', 100)), 'B': pct(('P1', 50), ('P2', 50)), 'C': pct(('P1', 50), ('P2', 50), ('P3', 0))})),
    'S24': table(job([('A', 'L1', 'X', 32, 49), ('B', 'L1', 'X', 32, 100), ('C', 'L1', 'X', 32, 69)])),
}

# Pins: any change here is a rule change and needs SCENARIOS.md and SPEC.md updated.
assert split(3, pct(('P1', 70), ('P2', 30))) == {'P1': 3, 'P2': 0}, 'others round down, the main customer takes the rest'
assert split(3, pct(('P1', 30), ('P2', 70))) == {'P1': 1, 'P2': 2}
assert split(1, pct(('P1', 0), ('P2', 60), ('P3', 40))) == {'P1': 0, 'P2': 1, 'P3': 0}, 'main at 0%: largest share takes the rest'
assert split(60375, THIRDS) == {'P1': 20127, 'P2': 20124, 'P3': 20124}, 'thirds: the others round down, the grower takes 2 cents more'
assert split(-1, pct(('P1', 50), ('P2', 50))) == {'P1': 0, 'P2': -1}, 'credits as live: others floor away from zero'
assert cents(F(6895, 10)) == 690 and cents(F(-6895, 10)) == -690, 'half up on exact values'
assert by_field(cents(F(1001)), {'A': F(1, 2), 'B': F(1, 2)}) == {'A': 501, 'B': 500}, '1 gal at $10.01 over two equal fields bills $10.01'
# A job never bills more or less than quantity x price, product by product.
assert TABLES['S1'][2] == cents(57 * F(4137)) + cents(228 * F(SVC)) + cents(228 * F(FUEL))
assert TABLES['S4b'][2] == cents(F(89 * 32, 128) * 4137) + cents(F(139 * 24, 128) * 2319) + cents(228 * F(SVC)) + cents(228 * F(FUEL))

if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    if '--check' in sys.argv:
        doc = io.open(__file__.replace('scenarios-calc.py', 'SCENARIOS.md'), encoding='utf-8').read().replace('\r\n', '\n')
        bad = [k for k, (t, _, _) in TABLES.items()
               if (m := re.search(r'<!-- calc:' + k + r' -->\n((?:\|[^\n]*\n)+)', doc)) is None or m.group(1).rstrip('\n') != t]
        tags = re.findall(r'<!-- calc:(\w+) -->', doc)
        if sorted(tags) != sorted(TABLES):
            bad.append(f'tags {sorted(tags)} vs tables {sorted(TABLES)}')
        print('SCENARIOS tables match' if not bad else f'MISMATCH: {bad}')
        sys.exit(1 if bad else 0)
    for k, (t, _, _) in TABLES.items():
        print(f'<!-- calc:{k} -->\n{t}\n')
