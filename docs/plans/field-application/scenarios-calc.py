# Reference calculator for SCENARIOS.md: exact decimals, whole cents, no floating point.
#   python -I scenarios-calc.py          prints the tables
#   python -I scenarios-calc.py --check  fails if SCENARIOS.md tables differ from the printed ones
# Rules (SCENARIOS.md "Rules the numbers follow"; Mason 2026-11-24: "billing logic and rounding matches chemical sales"):
#   1. Bill what actually went in the tank (Mason, 2026-11-24): each load's billed gallons of a product = what was put
#      in the load (confirmed mix, adds and corrections, plus any carried in) minus what was carried out or sent to a
#      tote. A field's quantity = the sum over the loads that sprayed it of (load gallons x acres that load sprayed on the
#      field / all acres that load sprayed). Each product is priced ONCE per job: total quantity x price, rounded half up
#      to whole cents once. Service: total sprayed acres x rate, rounded once, only when the job's application service
#      bills the customer. No fuel charge.
#   2. That job total is shared across the fields by quantity (acres for service) with the chemical-sale rule:
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
    return out   # no sign check: live gives the main payer +1 on a -1 cent thirds line (pinned below)


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
    out = [(p, D(v) * MICRO / 100) for p, v in ps]
    assert all(m == m.to_integral_value() for _, m in out), f'share finer than one micro-percent: {ps}'
    return [(p, int(m)) for p, m in out]


def show(q):
    return format((D(q.numerator) / D(q.denominator)).quantize(D('0.0001')).normalize(), 'f')


THIRDS = [('P1', 33_333_334), ('P2', 33_333_333), ('P3', 33_333_333)]
FIELDS = {'A': pct(('P1', 100)), 'B': pct(('P1', 50), ('P2', 50)), 'C': THIRDS}
PRICE = {'X': 4137, 'Y': 2319}   # made-up cents per gallon
SVC = 875                        # made-up cents per acre; no fuel charge (Mason, 2026-11-24)


def job(work, loads, prod_shares=FIELDS, app_shares=None, order=None, service=True):
    """work: list of (field, load_id, acres) sprayed segments (one pass can take several products).
    loads: {load_id: {product: billed gallons}} = put in, minus carried out or to a tote.
    order: saved spray order (defaults to first appearance in work); it, not entry order, picks the cent taker."""
    fields = order or list(dict.fromkeys(w[0] for w in work))
    load_acres = {}
    for f, l, a in work:
        load_acres[l] = load_acres.get(l, F(0)) + F(a)
    qty = {}   # product -> {field: gallons}, fields in spray order
    acres = {f: F(0) for f in fields}
    for f, l, a in work:
        acres[f] += F(a)
    for f in fields:
        for fw, l, a in work:
            if fw != f:
                continue
            for p, g in loads[l].items():
                qty.setdefault(p, {})
                qty[p][f] = qty[p].get(f, F(0)) + F(g) * F(a) / load_acres[l]
    line = {}  # (field, line name) -> (qty text, cents)
    for p, per_field in qty.items():
        c = by_field(cents(sum(per_field.values()) * PRICE[p]), per_field)
        for f in per_field:
            line[(f, p)] = (f'{show(per_field[f])} gal', c[f])
    if service:
        c = by_field(cents(sum(acres.values()) * SVC), acres)
        for f in fields:
            line[(f, 'Service')] = (f'{show(acres[f])} ac', c[f])
    rows = []
    for f in fields:
        for p in qty:
            if f in qty[p]:
                rows.append((f, p) + line[(f, p)] + (prod_shares[f],))
        if service:
            rows.append((f, 'Service') + line[(f, 'Service')] + ((app_shares or prod_shares)[f],))
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


STD = [('A', 'L1', 49), ('B', 'L1', 110), ('C', 'L1', 69)]
L58 = {'L1': {'X': 58}}           # 58 gal X put in, ran dry
s6 = job(STD, L58)
s6[2] = s6[2][:4] + (pct(('P1', 100), ('P2', 0)),)
S4L = {'L1': {'X': F('12.25')}, 'L2': {'Y': F('33.5625')}}
S4BL = {'L1': {'X': F('22.25')}, 'L2': {'Y': F('26.0625')}}
S4B = [('A', 'L1', 49), ('B', 'L1', 40), ('B', 'L2', 70), ('C', 'L2', 69)]
TABLES = {
    'S1': table(job(STD, L58)),
    'S2': table(job([('A', 'L1', 49), ('B', 'L1', 110), ('C', 'L1', '68.7')], L58)),
    'S3': table(job(STD, L58, app_shares={'A': pct(('P1', 100)), 'B': pct(('P1', 100), ('P2', 0)), 'C': pct(('P1', 50), ('P2', 50), ('P3', 0))})),
    'S4': table(job([('A', 'L1', 49), ('B', 'L2', 110), ('C', 'L2', 69)], S4L)),
    'S4b': table(job(S4B, S4BL)),
    'S6': table(s6),
    'S9': table(job(STD, L58, prod_shares={'A': pct(('P1', 100)), 'B': pct(('P1', 50), ('P2', 50)), 'C': pct(('P1', 50), ('P2', 50), ('P3', 0))})),
    'S24': table(job([('A', 'L1', 49), ('B', 'L1', 100), ('C', 'L1', 69)], L58)),
    'S32': table(job(STD, {'L1': {'X': 58, 'Y': F('42.75')}}, service=False)),
}

# Pins: any change here is a rule change and needs SCENARIOS.md and SPEC.md updated.
assert split(3, pct(('P1', 70), ('P2', 30))) == {'P1': 3, 'P2': 0}, 'others round down, the main customer takes the rest'
assert split(3, pct(('P1', 30), ('P2', 70))) == {'P1': 1, 'P2': 2}
assert split(1, pct(('P1', 0), ('P2', 60), ('P3', 40))) == {'P1': 0, 'P2': 1, 'P3': 0}, 'main at 0%: largest share takes the rest'
assert split(60375, THIRDS) == {'P1': 20127, 'P2': 20124, 'P3': 20124}, 'thirds: the others round down, the grower takes 2 cents more'
assert split(-1, pct(('P1', 50), ('P2', 50))) == {'P1': 0, 'P2': -1}, 'credits as live: others floor away from zero'
assert split(-1, THIRDS) == {'P1': 1, 'P2': -1, 'P3': -1}, 'live: a -1 cent thirds credit gives the main customer +1'
try:
    pct(('P1', '33.3333333'))
    raise SystemExit('pct must refuse a share finer than one micro-percent')
except AssertionError:
    pass
assert cents(F(6895, 10)) == 690 and cents(F(-6895, 10)) == -690, 'half up on exact values'
assert by_field(cents(F(1001)), {'A': F(1, 2), 'B': F(1, 2)}) == {'A': 501, 'B': 500}, '1 gal at $10.01 over two equal fields bills $10.01'
# All lines add up to the job amount rounded ONCE per product (quantity x price, then one rounding).
assert TABLES['S1'][2] == cents(58 * F(4137)) + cents(228 * F(SVC))
assert TABLES['S4b'][2] == cents(F('22.25') * 4137) + cents(F('26.0625') * 2319) + cents(228 * F(SVC))
assert TABLES['S32'][2] == cents(58 * F(4137)) + cents(F('42.75') * 2319), 'custom applicator: products only, no service line'
# One pass with two products counts its acres once (Sol 99).
_two = job([('A', 'L1', 10)], {'L1': {'X': 1, 'Y': 1}})
assert [r[2] for r in _two if r[1] == 'Service'] == ['10 ac']
# Spray order, not entry order, picks the cent taker (Sol 101): B entered first, A first in spray order, equal acres.
_ord = job([('B', 'L1', 1), ('A', 'L1', 1)], {'L1': {'X': F(1001, 4137)}}, prod_shares={'A': pct(('P1', 100)), 'B': pct(('P1', 100))}, order=['A', 'B'], service=False)
assert {r[0]: r[3] for r in _ord} == {'A': 501, 'B': 500}

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
