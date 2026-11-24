# Reference calculator for SCENARIOS.md: exact decimals, whole cents, no floating point.
#   python -I scenarios-calc.py          prints the tables
#   python -I scenarios-calc.py --check  fails if SCENARIOS.md tables differ from the printed ones
# Rules (SCENARIOS.md "Rules the numbers follow"):
#   1. Each field line is priced on its own: quantity x price, rounded half up to whole cents once.
#      Product quantity = sum over the loads that sprayed the field of (load rate fl oz/acre x acres sprayed from that load / 128).
#      "Bill actual used" replaces a load's rate with (actual gallons x 128 / acres the load sprayed). Quantities are exact.
#   2. A field line is split over payers by micro-percent shares: floor each exact share, hand the leftover cents
#      one at a time by largest remainder; ties to the bigger share, then the field's payer rank (grower first).
#      A 0% payer never gets a cent. Negative amounts (credits) are split on their absolute value and re-signed.
import io
import re
import sys
from decimal import Decimal as D
from fractions import Fraction as F
import math

MICRO = 100_000_000


def cents(x):
    """Exact rational in, whole cents out, half up (away from zero). Never rounds an intermediate value."""
    x = F(x)
    sign = -1 if x < 0 else 1
    return sign * math.floor(abs(x) + F(1, 2))


def split(total, shares):
    """shares: list of (payer, micro_pct) in payer-rank order (grower first)."""
    assert all(isinstance(s, int) and 0 <= s <= MICRO for _, s in shares), shares
    assert sum(s for _, s in shares) == MICRO, shares
    assert len({p for p, _ in shares}) == len(shares), shares
    sign, amt = (-1 if total < 0 else 1), abs(total)
    out = {p: amt * s // MICRO for p, s in shares}
    rem = {p: amt * s % MICRO for p, s in shares}
    left = amt - sum(out.values())
    rank = {p: i for i, (p, _) in enumerate(shares)}
    share = dict(shares)
    order = sorted((p for p, s in shares if s > 0), key=lambda p: (-rem[p], -share[p], rank[p]))
    for k in range(left):
        out[order[k % len(order)]] += 1
    out = {p: sign * v for p, v in out.items()}
    assert sum(out.values()) == total
    return out


def pct(*ps):
    return [(p, int(D(v) * MICRO / 100)) for p, v in ps]


THIRDS = [('P1', 33_333_334), ('P2', 33_333_333), ('P3', 33_333_333)]
FIELDS = {'A': pct(('P1', 100)), 'B': pct(('P1', 50), ('P2', 50)), 'C': THIRDS}
PRICE = {'X': 4137, 'Y': 2319}   # made-up cents per gallon
SVC, FUEL = 875, 65              # made-up cents per acre


def job(work, prod_shares=FIELDS, app_shares=None, actual=None):
    """work: list of (field, load_id, product, rate_floz_per_acre, acres). actual: {load_id: gallons}."""
    actual = actual or {}
    # shortcut: one product per load in these fixtures; a multi-product load needs one work segment per load, not per product.
    assert len({(w[1], w[2]) for w in work}) == len({w[1] for w in work}), 'one product per load'
    load_acres = {}
    for f, l, p, r, a in work:
        load_acres[l] = load_acres.get(l, 0) + F(a)
    assert all(load_acres[l] > 0 for l in actual), 'a zero-acre load bills no product'
    rows, fields = [], list(dict.fromkeys(w[0] for w in work))
    for f in fields:
        mine = [w for w in work if w[0] == f]
        for prod in dict.fromkeys(w[2] for w in mine):
            q = F(0)
            for _, l, p, r, a in mine:
                if p == prod:
                    rate = F(actual[l]) * 128 / load_acres[l] if l in actual else F(r)
                    q += rate * F(a) / 128
            shown = (D(q.numerator) / D(q.denominator)).quantize(D('0.0001')).normalize()
            rows.append((f, prod, f'{shown} gal', cents(q * PRICE[prod]), prod_shares[f]))
        acres = sum(F(w[4]) for w in mine)
        shown = (D(acres.numerator) / D(acres.denominator)).normalize()
        for name, rate in (('Service', SVC), ('Fuel', FUEL)):
            rows.append((f, name, f'{shown} ac', cents(acres * rate), (app_shares or prod_shares)[f]))
    return rows


def table(rows):
    lines = ['| Field | Line | Qty | Field total (cents) | P1 | P2 | P3 |', '|---|---|---|---|---|---|---|']
    tot = {'P1': 0, 'P2': 0, 'P3': 0}
    grand = 0
    for f, name, qty, amt, sh in rows:
        s = split(amt, sh)
        grand += amt
        for p in s:
            tot[p] += s[p]
        lines.append(f'| {f} | {name} | {qty} | {amt} | ' + ' | '.join(str(s[p]) if p in s else '-' for p in ('P1', 'P2', 'P3')) + ' |')
    assert sum(tot.values()) == grand
    lines.append(f'| **Total** | | | **{grand}** | **{tot["P1"]}** | **{tot["P2"]}** | **{tot["P3"]}** |')
    return '\n'.join(lines), tot


STD = [('A', 'L1', 'X', 32, 49), ('B', 'L1', 'X', 32, 110), ('C', 'L1', 'X', 32, 69)]
s6 = job(STD)
s6[3] = s6[3][:4] + (pct(('P1', 100), ('P2', 0)),)
TABLES = {
    'S1': table(job(STD)),
    'S2': table(job([('A', 'L1', 'X', 32, 49), ('B', 'L1', 'X', 32, 110), ('C', 'L1', 'X', 32, '68.7')])),
    'S3': table(job(STD, app_shares={'A': pct(('P1', 100)), 'B': pct(('P1', 100), ('P2', 0)), 'C': pct(('P1', 50), ('P2', 50), ('P3', 0))})),
    'S4': table(job([('A', 'L1', 'X', 32, 49), ('B', 'L2', 'Y', 24, 110), ('C', 'L2', 'Y', 24, 69)])),
    'S4b': table(job([('A', 'L1', 'X', 32, 49), ('B', 'L1', 'X', 32, 40), ('B', 'L2', 'Y', 24, 70), ('C', 'L2', 'Y', 24, 69)])),
    'S5': table([r for r in job(STD, actual={'L1': '61.5'}) if r[1] not in ('Service', 'Fuel')]),
    'S6': table(s6),
    'S9': table(job(STD, prod_shares={'A': pct(('P1', 100)), 'B': pct(('P1', 50), ('P2', 50)), 'C': pct(('P1', 50), ('P2', 50), ('P3', 0))})),
    'S24': table(job([('A', 'L1', 'X', 32, 49), ('B', 'L1', 'X', 32, 100), ('C', 'L1', 'X', 32, 69)])),
}

# Pins: any change here is a rule change and needs SCENARIOS.md and Mason's decision record updated.
assert split(3, pct(('P1', 70), ('P2', 30))) == {'P1': 2, 'P2': 1}
assert split(60375, THIRDS) == {'P1': 20125, 'P2': 20125, 'P3': 20125}
assert split(-1, pct(('P1', 50), ('P2', 50))) == {'P1': -1, 'P2': 0}
assert split(2, pct(('P1', 75), ('P2', 25))) == {'P1': 2, 'P2': 0}
assert cents(F(6895, 10)) == 690 and cents(F(-6895, 10)) == -690, 'half up on exact values'
assert TABLES['S24'][1]['P3'] == TABLES['S1'][1]['P3'], 'a payer with no share on a corrected field must not move'

if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    if '--check' in sys.argv:
        doc = io.open(__file__.replace('scenarios-calc.py', 'SCENARIOS.md'), encoding='utf-8').read()
        bad = [k for k, (t, _) in TABLES.items()
               if (m := re.search(r'<!-- calc:' + k + r' -->\n((?:\|[^\n]*\n)+)', doc)) is None or m.group(1).rstrip('\n') != t]
        tags = re.findall(r'<!-- calc:(\w+) -->', doc)
        if sorted(tags) != sorted(TABLES):
            bad.append(f'tags {sorted(tags)} vs tables {sorted(TABLES)}')
        print('SCENARIOS tables match' if not bad else f'MISMATCH: {bad}')
        sys.exit(1 if bad else 0)
    for k, (t, _) in TABLES.items():
        print(f'<!-- calc:{k} -->\n{t}\n')
