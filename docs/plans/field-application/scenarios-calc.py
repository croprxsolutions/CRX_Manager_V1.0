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
#      customer) gets the rest; if the main customer has 0% on that line, the largest share gets it (ties: lowest
#      customer id, IDS below, as live). Credits, as live: every other share floors away from zero.
import io
import re
import sys
from decimal import Decimal as D
from fractions import Fraction as F
import math

MICRO = 100_000_000
MAIN = 'P1'   # the job's customer (the grower)
IDS = {'P1': 3, 'P2': 1, 'P3': 2}   # made-up customer ids: P2 sorts lowest, so ties do not follow payer order
DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']   # split tags that are spray days sort by date (Sol r2 109)


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
    taker = main if sh.get(main, 0) > 0 else max(sh, key=lambda p: (sh[p], -IDS[p]))   # ties: lowest customer id
    out = take_rest(total, sh, taker)
    assert sum(out.values()) == total
    return out


def by_field(total, weights):
    """Rule 2: weights in spray order; the taker is the biggest, ties to the earlier field. Zero weights get 0."""
    keys = [k for k in weights if weights[k] > 0]
    taker = max(keys, key=lambda k: (weights[k], -keys.index(k)))
    out = take_rest(total, {k: weights[k] for k in keys}, taker)
    return {k: out.get(k, 0) for k in weights}


def pct(*ps):
    out = [(p, D(v) * MICRO / 100) for p, v in ps]
    assert all(m == m.to_integral_value() for _, m in out), f'share finer than one micro-percent: {ps}'
    return [(p, int(m)) for p, m in out]


def units(q):
    """Exact quantity -> stored 1/10000 units, half up (contract B3), never Decimal's default half-even."""
    return cents(F(q) * 10000)


def show(q):
    return format((D(units(q)) / 10000).normalize(), 'f')


THIRDS = [('P1', 33_333_334), ('P2', 33_333_333), ('P3', 33_333_333)]
FIELDS = {'A': pct(('P1', 100)), 'B': pct(('P1', 50), ('P2', 50)), 'C': THIRDS}
PRICE = {'X': 4137, 'Y': 2319}   # made-up cents per gallon
SVC = 875                        # made-up cents per acre; no fuel charge (Mason, 2026-11-24)


def job(work, loads, prod_shares=FIELDS, app_shares=None, order=None, service=True):
    """work: list of (field, load_id, acres[, split]) sprayed segments (one pass can take several products).
    split: which field split was in force on the spray day (S7): one line per split, the larger line taking the rest.
    loads: {load_id: {product: billed gallons}} = put in, minus carried out or to a tote.
    order: saved spray order (defaults to first appearance in work); it, not entry order, picks the cent taker.
    Shares are looked up by field, or by (field, split) when a field has more than one split."""
    work = [tuple(w) if len(w) == 4 else tuple(w) + (None,) for w in work]
    if sum(F(w[2]) for w in work) == 0:
        return []   # nothing sprayed: no lines, never planned acres (Sol 100)
    fields = [f for f in (order or dict.fromkeys(w[0] for w in work)) if any(w[0] == f for w in work)]
    # split buckets sort by spray date, not entry order (ties go to the earlier date)
    tags = {f: sorted(dict.fromkeys(w[3] for w in work if w[0] == f), key=lambda t: DAYS.index(t) if t in DAYS else -1)
            for f in fields}
    load_acres = {}
    for f, l, a, t in work:
        load_acres[l] = load_acres.get(l, F(0)) + F(a)
    qty = {}   # product -> {field: {split: gallons}}, fields in spray order
    acres = {f: {t: F(0) for t in tags[f]} for f in fields}
    for f, l, a, t in work:
        acres[f][t] += F(a)
    for f in fields:
        for fw, l, a, t in work:
            if fw != f or load_acres[l] == 0:   # a load with no sprayed acres spreads nothing
                continue
            for p, g in loads[l].items():
                q = qty.setdefault(p, {}).setdefault(f, {tt: F(0) for tt in tags[f]})
                q[t] += F(g) * F(a) / load_acres[l]
    # zero-use products and zero-acre fields get no line (a recorded 0 stays on the work entry, not the bill)
    qty = {p: {f: v for f, v in pf.items() if sum(v.values()) > 0} for p, pf in qty.items()}
    qty = {p: pf for p, pf in qty.items() if pf}

    def spread(total, per_field):   # rule 2: across fields, then across one field's split lines (positive weights only)
        c = by_field(total, {f: sum(v.values()) for f, v in per_field.items()})
        return {(f, t): ct for f, v in per_field.items() if c[f] or sum(v.values())
                for t, ct in by_field(c[f], v).items() if v[t] > 0}
    line = {}  # (field, split, line name) -> (qty text, cents)
    for p, per_field in qty.items():
        c = spread(cents(sum(sum(v.values()) for v in per_field.values()) * PRICE[p]), per_field)
        for (f, t), ct in c.items():
            line[(f, t, p)] = (f'{show(per_field[f][t])} gal', ct)
    if service:
        c = spread(cents(sum(sum(v.values()) for v in acres.values()) * SVC), acres)
        for (f, t), ct in c.items():
            line[(f, t, 'Service')] = (f'{show(acres[f][t])} ac', ct)

    def shares(table, f, t):
        return table[(f, t)] if len(tags[f]) > 1 else table[f]
    rows = []
    for f in fields:
        for t in tags[f]:
            label = f if len(tags[f]) == 1 else f'{f} ({t})'
            for p in qty:
                if (f, t, p) in line:
                    rows.append((label, p) + line[(f, t, p)] + (shares(prod_shares, f, t),))
            if service and (f, t, 'Service') in line:
                rows.append((label, 'Service') + line[(f, t, 'Service')] + (shares(app_shares or prod_shares, f, t),))
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
S7W = [('A', 'L1', 49), ('B', 'L1', 60, 'Tue'), ('B', 'L1', 50, 'Thu'), ('C', 'L1', 69)]
ROWS = {
    'S1': job(STD, L58),
    'S2': job([('A', 'L1', 49), ('B', 'L1', 110), ('C', 'L1', '68.7')], L58),
    'S3': job(STD, L58, app_shares={'A': pct(('P1', 100)), 'B': pct(('P1', 100), ('P2', 0)), 'C': pct(('P1', 50), ('P2', 50), ('P3', 0))}),
    'S4': job([('A', 'L1', 49), ('B', 'L2', 110), ('C', 'L2', 69)], S4L),
    'S4b': job(S4B, S4BL),
    'S6': s6,
    'S9': job(STD, L58, prod_shares={'A': pct(('P1', 100)), 'B': pct(('P1', 50), ('P2', 50)), 'C': pct(('P1', 50), ('P2', 50), ('P3', 0))}),
    'S7': job(S7W, L58, prod_shares={**FIELDS, ('B', 'Tue'): pct(('P1', 50), ('P2', 50)), ('B', 'Thu'): pct(('P1', 100))}),
    'S24': job([('A', 'L1', 49), ('B', 'L1', 100), ('C', 'L1', 69)], L58),
    'S26': job([('A', 'L1', 110), ('B', 'L1', 110), ('C', 'L1', 69)], L58),
    'S32': job(STD, {'L1': {'X': 58, 'Y': F('42.75')}}, service=False),
}
TABLES = {k: table(v) for k, v in ROWS.items()}

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
# S7: field B's part of the job total is the same as in S1; only its two split lines share it (Sol 103).
assert sum(r[3] for r in job(S7W, L58, prod_shares={**FIELDS, ('B', 'Tue'): FIELDS['B'], ('B', 'Thu'): FIELDS['B']})
           if r[0].startswith('B')) == sum(r[3] for r in job(STD, L58) if r[0] == 'B')
# S26: correcting field A's acres moves money for every payer, not only A's (Sol 97): billed gallons spread by acres.
assert all(TABLES['S26'][1][p] != TABLES['S1'][1][p] for p in ('P1', 'P2', 'P3'))
# Nothing sprayed: no lines, no invoice (Sol 100).
assert job([('A', 'L1', 0)], L58) == [] and table([])[2] == 0


def live_split(amount, units, shares, main, ids):
    """Line-for-line copy of live _bill_split_line_shares (20261215110000), explicit customer ids (Sol 13, 102).
    units are 1/10000 of a unit (an invoice line's 4 decimals). Returns {payer: (cents, units)}."""
    sh = {p: s for p, s in shares if s > 0}
    rank = sorted(sh, key=lambda p: (p != main, -sh[p], ids[p]))
    out = {}
    for p in rank[1:]:
        hund = math.floor(F(units) * sh[p] / MICRO / 100)
        out[p] = (math.floor(F(amount) * sh[p] / MICRO), hund * 100 if hund > 0 else math.floor(F(units) * sh[p] / MICRO))
    out[rank[0]] = (amount - sum(c for c, _ in out.values()), units - sum(u for _, u in out.values()))
    return out


assert live_split(-1, -310, pct(('P1', 50), ('P2', 50)), 'P1', IDS) == {'P2': (-1, -155), 'P1': (0, -155)}, 'signed quantity: 4-place branch'
assert live_split(1, 10000, THIRDS, 'P1', IDS) == {'P2': (0, 3300), 'P3': (0, 3300), 'P1': (1, 3400)}, '1 unit over thirds: hundredths'
assert live_split(1, 1, pct(('P1', 0), ('P2', 50), ('P3', 50)), 'P1', IDS)['P2'] == (1, 1), 'main at 0%, tie: lowest customer id'
assert live_split(1, 100, pct(('P1', 50), ('P2', 50)), 'P1', IDS) == {'P2': (0, 50), 'P1': (1, 50)}, 'quantity with no cents (Sol 15)'
# Cents parity with the live helper on every line of every table, with the line's real stored units
# (rule 3 = live, main customer = P1); every payer's units add up to the line (Sol r2 111).
for _k, _rows in ROWS.items():
    for _f, _n, _q, _amt, _sh in _rows:
        _u = units(F(_q.split()[0]))
        _lv = live_split(_amt, _u, _sh, 'P1', IDS)
        assert all(_lv.get(p, (0, 0))[0] == c for p, c in split(_amt, _sh).items()), (_k, _f, _n)
        assert sum(u for _, u in _lv.values()) == _u, (_k, _f, _n)
# One pass with two products counts its acres once (Sol 99).
_two = job([('A', 'L1', 10)], {'L1': {'X': 1, 'Y': 1}})
assert [r[2] for r in _two if r[1] == 'Service'] == ['10 ac']
# Spray order, not entry order, picks the cent taker (Sol 101): B entered first, A first in spray order, equal acres.
_ord = job([('B', 'L1', 1), ('A', 'L1', 1)], {'L1': {'X': F(1001, 4137)}}, prod_shares={'A': pct(('P1', 100)), 'B': pct(('P1', 100))}, order=['A', 'B'], service=False)
assert {r[0]: r[3] for r in _ord} == {'A': 501, 'B': 500}

# Sol round 2 pins.
# 105: main at 0% with a tie goes to the lowest customer id, whatever the payer order.
assert split(1, [('P1', 0), ('P3', 50_000_000), ('P2', 50_000_000)]) == {'P1': 0, 'P3': 0, 'P2': 1}
# 106: stored quantity rounds half up: 0.0001 gal over two equal fields shows 0.0001 each, not 0.
assert show(F(1, 20000)) == '0.0001'
# 107/108: a zero-acre field, a load with no sprayed acres and a zeroed product make no line and no crash.
_z = job([('A', 'L1', 10), ('B', 'L2', 0)], {'L1': {'X': 1, 'Y': 0}, 'L2': {'X': 5}}, order=['A', 'B', 'C'])
assert [(r[0], r[1]) for r in _z] == [('A', 'X'), ('A', 'Service')]
# 109: split lines tie to the earlier spray date even when the later entry is supplied first.
_t = job([('B', 'L1', 1, 'Thu'), ('B', 'L1', 1, 'Tue')], {'L1': {'X': F(1001, 4137)}},
         prod_shares={('B', 'Tue'): pct(('P1', 100)), ('B', 'Thu'): pct(('P1', 100))}, service=False)
assert {r[0]: r[3] for r in _t} == {'B (Tue)': 501, 'B (Thu)': 500}
assert table(job(list(reversed(S7W)), L58, order=['A', 'B', 'C'], prod_shares={**FIELDS, ('B', 'Tue'): pct(('P1', 50), ('P2', 50)), ('B', 'Thu'): pct(('P1', 100))}))[0] == TABLES['S7'][0]
# 110: one entry over two load segments bills its acres once (S4b field B: 40 + 70 = 110 ac);
# a kept second pass on the same field and day bills again (M8).
assert [r[2] for r in ROWS['S4b'] if r[0] == 'B' and r[1] == 'Service'] == ['110 ac']
assert [r[2] for r in job([('A', 'L1', 10), ('A', 'L1', 10)], {'L1': {'X': 1}}) if r[1] == 'Service'] == ['20 ac']
# 112: a load shared by two jobs splits its used gallons by acres and conserves them; a vendor-sourced
# product (price 0) keeps its quantity at $0.
_L4 = F(50)
_j1, _j2 = _L4 * 60 / 100, _L4 * 40 / 100
assert _j1 + _j2 == _L4
PRICE['Z'] = 0   # vendor-sourced
_v = job([('A', 'L4', 60)], {'L4': {'X': _j1, 'Z': 10}}, service=False)
assert [(r[1], r[2], r[3]) for r in _v] == [('X', '30 gal', cents(30 * F(4137))), ('Z', '10 gal', 0)]
# 113: S25 credit and rebill (P2 paid 100,000 of 150,335). Payment unapplied, credit 150,335, new invoice
# 144,223 (S24), payment reapplied: new balance 44,223. If P3 had paid 44,328 in full and dropped to $0:
# credit 44,328 and the payment stays as P3's account credit.
assert TABLES['S1'][1]['P2'] == 150335 and TABLES['S24'][1]['P2'] == 144223 and TABLES['S24'][1]['P2'] - 100000 == 44223
assert TABLES['S1'][1]['P3'] == 44328
# 114: S26's A takes two residual cents over B.
assert [r[3] for r in ROWS['S26'] if r[1] == 'X'][:2] == [91330, 91328]


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
