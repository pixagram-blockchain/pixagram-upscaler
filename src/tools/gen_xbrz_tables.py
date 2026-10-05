#!/usr/bin/env python3
"""
xBRZ blend-table generator for arbitrary scale factors.

Zenju's hand-written Scaler2x..6x constants are per-pixel area coverages of
five analytic regions cut out of the unit source cell (canonical rotation =
bottom-right corner, x right, y down, destination pixel (row i, col j)
spanning [j/N,(j+1)/N] x [i/N,(i+1)/N]):

  shallow line        y >= 1 - x/2          (segment (0,1) -> (1,1/2))
  steep line          x >= 1 - y/2          (transpose)
  steep + shallow     union of the two half-planes
  45-degree diagonal  x + y >= 3/2
  rounded corner      quadrant x,y >= 1/2 beyond the inscribed circle of
                      radius 1/2 centred on the cell centre

This script recomputes those coverages exactly (rational arithmetic for the
line shapes, analytic circle integrals for the corner), verifies that it
reproduces every constant of the reference Scaler2x..6x, then emits the
Scaler7x/Scaler8x Rust impls and the GLSL weight tables for the 7x/8x
fragment shaders.

Known reference quirks handled explicitly:
  * Scaler5x blend_line_steep_and_shallow uses 2/3 at the line-crossing pixel
    (3,3) where the exact union coverage is 5/6 (2/3 is the coverage of the
    *intersection* of the two half-planes there). Zenju's own 2x and 4x use
    the exact union at the crossing pixel (5/6 and 1/3 - the 4x value even
    carries his comment "fixes 7/8 used in xBR"), so 7x/8x follow the exact
    union.
  * Scaler5x blend_corner omits the 0.84% sliver in the column that straddles
    the quadrant boundary x = 1/2 (odd N only). Same rule applied at 7x.
"""

from fractions import Fraction
from math import sqrt, asin
import os

# Output directory for the generated tables (override with XBRZ_WORK_DIR).
WORK_DIR = os.environ.get("XBRZ_WORK_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "out"))
os.makedirs(WORK_DIR, exist_ok=True)

F = Fraction

# ---------------------------------------------------------------------------
# Exact polygon clipping (rational)
# ---------------------------------------------------------------------------

def clip_halfplane(poly, a, b, c):
    """Sutherland-Hodgman clip of polygon by half-plane a*x + b*y >= c."""
    if not poly:
        return []
    out = []
    n = len(poly)
    for k in range(n):
        p = poly[k]
        q = poly[(k + 1) % n]
        pin = a * p[0] + b * p[1] >= c
        qin = a * q[0] + b * q[1] >= c
        if pin:
            out.append(p)
        if pin != qin:
            # intersection of segment pq with the line a*x + b*y = c
            denom = a * (q[0] - p[0]) + b * (q[1] - p[1])
            t = (c - a * p[0] - b * p[1]) / denom
            out.append((p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])))
    return out


def poly_area(poly):
    if len(poly) < 3:
        return F(0)
    s = F(0)
    n = len(poly)
    for k in range(n):
        x1, y1 = poly[k]
        x2, y2 = poly[(k + 1) % n]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def rect(x0, x1, y0, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


# Half-planes as (a, b, c) for a*x + b*y >= c
SHALLOW = (F(1), F(2), F(2))    # y >= 1 - x/2  <=>  x + 2y >= 2
STEEP   = (F(2), F(1), F(2))    # x >= 1 - y/2  <=>  2x + y >= 2
DIAG    = (F(1), F(1), F(3, 2)) # x + y >= 3/2


def pixel_rect(n, i, j):
    return rect(F(j, n), F(j + 1, n), F(i, n), F(i + 1, n))


def coverage_halfplanes(n, i, j, planes):
    """Exact coverage of the intersection of half-planes within pixel (i,j)."""
    poly = pixel_rect(n, i, j)
    for pl in planes:
        poly = clip_halfplane(poly, *pl)
    return poly_area(poly) * n * n


def line_tables(n):
    """Exact rational coverage tables for the four line shapes at scale n."""
    sh, st, ss, dg = {}, {}, {}, {}
    for i in range(n):
        for j in range(n):
            a = coverage_halfplanes(n, i, j, [SHALLOW])
            b = coverage_halfplanes(n, i, j, [STEEP])
            both = coverage_halfplanes(n, i, j, [SHALLOW, STEEP])
            d = coverage_halfplanes(n, i, j, [DIAG])
            u = a + b - both  # inclusion-exclusion: union coverage
            if a:
                sh[(i, j)] = a
            if b:
                st[(i, j)] = b
            if u:
                ss[(i, j)] = u
            if d:
                dg[(i, j)] = d
    return sh, st, ss, dg


# ---------------------------------------------------------------------------
# Corner: area beyond the inscribed circle, per pixel, analytic
# ---------------------------------------------------------------------------

R = 0.5


def _F(u):
    """Antiderivative of sqrt(R^2 - u^2)."""
    u = min(max(u, -R), R)
    return (u * sqrt(max(R * R - u * u, 0.0))) / 2 + (R * R / 2) * asin(u / R)


def circle_strip_area(u0, u1, v0, v1):
    """Area of {(u,v): u0<=u<=u1, v0<=v<=v1, u^2+v^2 <= R^2} (all >= 0)."""
    u0, u1 = max(u0, 0.0), min(u1, R)
    if u1 <= u0 or v0 >= R:
        return 0.0

    def s(u):
        return sqrt(max(R * R - u * u, 0.0))

    # inside height at u: clamp(s(u), v0, v1) - v0, zero where s(u) <= v0
    # breakpoints: s(u) = v1 at u = sqrt(R^2 - v1^2); s(u) = v0 at sqrt(R^2 - v0^2)
    ua = sqrt(max(R * R - v1 * v1, 0.0)) if v1 < R else 0.0
    ub = sqrt(max(R * R - v0 * v0, 0.0))
    area = 0.0
    # segment 1: u in [u0, min(u1, ua)] -> full height v1 - v0
    lo, hi = u0, min(u1, ua)
    if hi > lo:
        area += (hi - lo) * (v1 - v0)
    # segment 2: u in [max(u0, ua), min(u1, ub)] -> height s(u) - v0
    lo, hi = max(u0, ua), min(u1, ub)
    if hi > lo:
        area += (_F(hi) - _F(lo)) - v0 * (hi - lo)
    return area


def corner_coverages(n):
    """Float coverage of the beyond-circle quadrant region per pixel (i,j)."""
    out = {}
    for i in range(n):
        for j in range(n):
            # pixel in (u, v) = (x - 1/2, y - 1/2) coordinates
            u0, u1 = j / n - 0.5, (j + 1) / n - 0.5
            v0, v1 = i / n - 0.5, (i + 1) / n - 0.5
            # clip to quadrant u, v >= 0
            cu0, cu1 = max(u0, 0.0), u1
            cv0, cv1 = max(v0, 0.0), v1
            if cu1 <= cu0 or cv1 <= cv0:
                continue
            quad_area = (cu1 - cu0) * (cv1 - cv0)
            inside = circle_strip_area(cu0, cu1, cv0, cv1)
            outside = quad_area - inside
            cov = outside * n * n  # relative to full pixel area 1/n^2
            if cov > 1e-12:
                # straddle rule (Zenju, Scaler5x): a pixel whose column or row
                # contains the quadrant boundary strictly inside is dropped
                straddles = (u0 < 0.0 < u1) or (v0 < 0.0 < v1)
                out[(i, j)] = (cov, straddles)
    return out


def corner_table(n):
    """(i,j) -> rounded /100 numerator, applying straddle + zero-round drops."""
    tbl = {}
    exact = {}
    for (i, j), (cov, straddles) in corner_coverages(n).items():
        if straddles:
            continue
        m = round(cov * 100)
        if m == 0:
            continue
        tbl[(i, j)] = m
        exact[(i, j)] = cov
    return tbl, exact


# ---------------------------------------------------------------------------
# Reference tables transcribed from scaler.rs (Scaler2x..Scaler6x)
# ---------------------------------------------------------------------------

SET = "set"

REF = {
    2: {
        "shallow":  {(1, 0): F(1, 4), (1, 1): F(3, 4)},
        "steep":    {(0, 1): F(1, 4), (1, 1): F(3, 4)},
        "sas":      {(1, 0): F(1, 4), (0, 1): F(1, 4), (1, 1): F(5, 6)},
        "diag":     {(1, 1): F(1, 2)},
        "corner":   {(1, 1): 21},
    },
    3: {
        "shallow":  {(2, 0): F(1, 4), (1, 2): F(1, 4), (2, 1): F(3, 4), (2, 2): SET},
        "steep":    {(0, 2): F(1, 4), (2, 1): F(1, 4), (1, 2): F(3, 4), (2, 2): SET},
        "sas":      {(2, 0): F(1, 4), (0, 2): F(1, 4), (2, 1): F(3, 4), (1, 2): F(3, 4), (2, 2): SET},
        "diag":     {(1, 2): F(1, 8), (2, 1): F(1, 8), (2, 2): F(7, 8)},
        "corner":   {(2, 2): 45},
    },
    4: {
        "shallow":  {(3, 0): F(1, 4), (2, 2): F(1, 4), (3, 1): F(3, 4), (2, 3): F(3, 4),
                     (3, 2): SET, (3, 3): SET},
        "steep":    {(0, 3): F(1, 4), (2, 2): F(1, 4), (1, 3): F(3, 4), (3, 2): F(3, 4),
                     (2, 3): SET, (3, 3): SET},
        "sas":      {(3, 1): F(3, 4), (1, 3): F(3, 4), (3, 0): F(1, 4), (0, 3): F(1, 4),
                     (2, 2): F(1, 3), (3, 3): SET, (3, 2): SET, (2, 3): SET},
        "diag":     {(3, 2): F(1, 2), (2, 3): F(1, 2), (3, 3): SET},
        "corner":   {(3, 3): 68, (3, 2): 9, (2, 3): 9},
    },
    5: {
        "shallow":  {(4, 0): F(1, 4), (3, 2): F(1, 4), (2, 4): F(1, 4),
                     (4, 1): F(3, 4), (3, 3): F(3, 4),
                     (4, 2): SET, (4, 3): SET, (4, 4): SET, (3, 4): SET},
        "steep":    {(0, 4): F(1, 4), (2, 3): F(1, 4), (4, 2): F(1, 4),
                     (1, 4): F(3, 4), (3, 3): F(3, 4),
                     (2, 4): SET, (3, 4): SET, (4, 4): SET, (4, 3): SET},
        "sas":      {(0, 4): F(1, 4), (2, 3): F(1, 4), (1, 4): F(3, 4),
                     (4, 0): F(1, 4), (3, 2): F(1, 4), (4, 1): F(3, 4),
                     (3, 3): F(2, 3),
                     (2, 4): SET, (3, 4): SET, (4, 4): SET, (4, 2): SET, (4, 3): SET},
        "diag":     {(4, 2): F(1, 8), (3, 3): F(1, 8), (2, 4): F(1, 8),
                     (4, 3): F(7, 8), (3, 4): F(7, 8), (4, 4): SET},
        "corner":   {(4, 4): 86, (4, 3): 23, (3, 4): 23},
    },
    6: {
        "shallow":  {(5, 0): F(1, 4), (4, 2): F(1, 4), (3, 4): F(1, 4),
                     (5, 1): F(3, 4), (4, 3): F(3, 4), (3, 5): F(3, 4),
                     (5, 2): SET, (5, 3): SET, (5, 4): SET, (5, 5): SET,
                     (4, 4): SET, (4, 5): SET},
        "steep":    {(0, 5): F(1, 4), (2, 4): F(1, 4), (4, 3): F(1, 4),
                     (1, 5): F(3, 4), (3, 4): F(3, 4), (5, 3): F(3, 4),
                     (2, 5): SET, (3, 5): SET, (4, 5): SET, (5, 5): SET,
                     (4, 4): SET, (5, 4): SET},
        "sas":      {(0, 5): F(1, 4), (2, 4): F(1, 4), (1, 5): F(3, 4), (3, 4): F(3, 4),
                     (5, 0): F(1, 4), (4, 2): F(1, 4), (5, 1): F(3, 4), (4, 3): F(3, 4),
                     (2, 5): SET, (3, 5): SET, (4, 5): SET, (5, 5): SET,
                     (4, 4): SET, (5, 4): SET, (5, 2): SET, (5, 3): SET},
        "diag":     {(5, 3): F(1, 2), (4, 4): F(1, 2), (3, 5): F(1, 2),
                     (4, 5): SET, (5, 5): SET, (5, 4): SET},
        "corner":   {(5, 5): 97, (4, 5): 42, (5, 4): 42, (5, 3): 6, (3, 5): 6},
    },
}

# Reference values that knowingly deviate from the analytic model
WAIVERS = {
    (5, "sas", (3, 3)): (F(2, 3), F(5, 6)),  # reference 2/3, exact union 5/6
}


def normalise(table):
    """Map exact coverages to blend values: full coverage -> SET."""
    out = {}
    for k, v in table.items():
        out[k] = SET if v == 1 else v
    return out


def validate():
    ok = True
    for n in range(2, 7):
        sh, st, ss, dg = line_tables(n)
        gen = {
            "shallow": normalise(sh),
            "steep": normalise(st),
            "sas": normalise(ss),
            "diag": normalise(dg),
        }
        for shape in ("shallow", "steep", "sas", "diag"):
            g, r = gen[shape], REF[n][shape]
            keys = set(g) | set(r)
            for k in sorted(keys):
                gv, rv = g.get(k), r.get(k)
                if gv == rv:
                    continue
                w = WAIVERS.get((n, shape, k))
                if w and rv == w[0] and gv == w[1]:
                    print(f"  waiver  {n}x {shape} {k}: reference {rv}, exact {gv}")
                    continue
                print(f"  MISMATCH {n}x {shape} {k}: generated {gv} vs reference {rv}")
                ok = False
        # corners
        ct, _ = corner_table(n)
        r = REF[n]["corner"]
        for k in sorted(set(ct) | set(r)):
            if ct.get(k) != r.get(k):
                print(f"  MISMATCH {n}x corner {k}: generated {ct.get(k)} vs reference {r.get(k)}")
                ok = False
    return ok


# ---------------------------------------------------------------------------
# Emission
# ---------------------------------------------------------------------------

def shallow_order(n, tbl):
    quarters = sorted([k for k, v in tbl.items() if v == F(1, 4)], key=lambda k: -k[0])
    threeq = sorted([k for k, v in tbl.items() if v == F(3, 4)], key=lambda k: -k[0])
    sets = sorted([k for k, v in tbl.items() if v == SET], key=lambda k: (-k[0], k[1]))
    return quarters, threeq, sets


def steep_order(n, tbl):
    quarters = sorted([k for k, v in tbl.items() if v == F(1, 4)], key=lambda k: k[0])
    threeq = sorted([k for k, v in tbl.items() if v == F(3, 4)], key=lambda k: k[0])
    sets = sorted([k for k, v in tbl.items() if v == SET], key=lambda k: (-k[1], k[0]))
    return quarters, threeq, sets


def frac_lit(v):
    return f"{v.numerator}/{v.denominator}"


def emit_rust(n, sh, st, ss, dg, corner):
    name = f"Scaler{n}x"
    L = []
    A = L.append
    A(f"pub(crate) struct {name};")
    A("")
    A(f"impl Scaler<{n}> for {name} {{")

    def blend_line(v, k):
        return f"        blend!({frac_lit(v)}, out[{k[0]}, {k[1]}], col);"

    def set_line(k):
        return f"        set!(out[{k[0]}, {k[1]}], col);"

    # shallow
    A(f"    fn blend_line_shallow<P: Pixel, const R: u8>(col: P, out: &mut OutputMatrix<P, {n}, R>) {{")
    q, t, s = shallow_order(n, sh)
    for k in q:
        A(blend_line(F(1, 4), k))
    A("")
    for k in t:
        A(blend_line(F(3, 4), k))
    A("")
    prev_row = None
    for k in s:
        if prev_row is not None and k[0] != prev_row:
            A("")
        A(set_line(k))
        prev_row = k[0]
    A("    }")
    A("")

    # steep
    A(f"    fn blend_line_steep<P: Pixel, const R: u8>(col: P, out: &mut OutputMatrix<P, {n}, R>) {{")
    q, t, s = steep_order(n, st)
    for k in q:
        A(blend_line(F(1, 4), k))
    A("")
    for k in t:
        A(blend_line(F(3, 4), k))
    A("")
    prev_col = None
    for k in s:
        if prev_col is not None and k[1] != prev_col:
            A("")
        A(set_line(k))
        prev_col = k[1]
    A("    }")
    A("")

    # steep and shallow
    A(f"    fn blend_line_steep_and_shallow<P: Pixel, const R: u8>(")
    A(f"        col: P,")
    A(f"        out: &mut OutputMatrix<P, {n}, R>,")
    A(f"    ) {{")
    cross = [(k, v) for k, v in ss.items() if v not in (F(1, 4), F(3, 4), SET)]
    steep_side_q = sorted([k for k, v in ss.items() if v == F(1, 4) and k[1] > k[0]], key=lambda k: k[0])
    steep_side_t = sorted([k for k, v in ss.items() if v == F(3, 4) and k[1] > k[0]], key=lambda k: k[0])
    shallow_side_q = sorted([k for k, v in ss.items() if v == F(1, 4) and k[0] > k[1]], key=lambda k: -k[0])
    shallow_side_t = sorted([k for k, v in ss.items() if v == F(3, 4) and k[0] > k[1]], key=lambda k: -k[0])
    for k in steep_side_q:
        A(blend_line(F(1, 4), k))
    for k in steep_side_t:
        A(blend_line(F(3, 4), k))
    A("")
    for k in shallow_side_q:
        A(blend_line(F(1, 4), k))
    for k in shallow_side_t:
        A(blend_line(F(3, 4), k))
    A("")
    for k, v in cross:
        A(blend_line(v, k) + " // exact union of the shallow and steep cuts")
    A("")
    sets = [k for k, v in ss.items() if v == SET]
    right_col = sorted([k for k in sets if k[1] == n - 1], key=lambda k: k[0])
    rest = sorted([k for k in sets if k[1] != n - 1], key=lambda k: (-k[0], k[1]))
    for k in right_col:
        A(set_line(k))
    A("")
    for k in rest:
        A(set_line(k))
    A("    }")
    A("")

    # diagonal
    A(f"    fn blend_line_diagonal<P: Pixel, const R: u8>(col: P, out: &mut OutputMatrix<P, {n}, R>) {{")
    partial_vals = sorted({v for v in dg.values() if v != SET})
    for v in partial_vals:
        for k in sorted([k for k, vv in dg.items() if vv == v], key=lambda k: -k[0]):
            A(blend_line(v, k))
        A("")
    for k in sorted([k for k, vv in dg.items() if vv == SET], key=lambda k: (k[0] + k[1], -k[0])):
        A(set_line(k))
    A("    }")
    A("")

    # corner
    A(f"    fn blend_corner<P: Pixel, const R: u8>(col: P, out: &mut OutputMatrix<P, {n}, R>) {{")
    ct, exact = corner
    items = sorted(ct.items(), key=lambda kv: (-kv[1], -kv[0][0], -kv[0][1]))
    for k, m in items:
        if m >= 100:
            A(set_line(k) + " // pixel lies fully beyond the corner arc")
        else:
            A(f"        blend!({m}/100, out[{k[0]}, {k[1]}], col); // exact: {exact[k]:.10f}")
    A("    }")
    A("}")
    return "\n".join(L)


def glsl_val(v, exact_corner=None):
    if exact_corner is not None:
        return f"{exact_corner:.10f}"
    if v == SET or v == 1:
        return "1.0"
    if v == 0:
        return "0.0"
    f = F(v)
    d = float(f)
    # exact decimals
    for num, den, lit in [(1, 4, "0.25"), (3, 4, "0.75"), (1, 2, "0.5"),
                          (1, 8, "0.125"), (7, 8, "0.875")]:
        if f == F(num, den):
            return lit
    return f"{f.numerator}.0/{f.denominator}.0"


def emit_glsl_tables(n, sh, st, ss, dg, corner):
    ct, exact = corner
    tables = {}
    for label, tbl in (("SH", sh), ("ST", st), ("SS", ss), ("DG", dg)):
        vals = []
        for i in range(n):
            for j in range(n):
                v = tbl.get((i, j), 0)
                vals.append(glsl_val(v))
        tables[label] = vals
    vals = []
    for i in range(n):
        for j in range(n):
            if (i, j) in ct:
                vals.append(glsl_val(None, exact_corner=exact[(i, j)])
                            if ct[(i, j)] < 100 else "1.0")
            else:
                vals.append("0.0")
    tables["CO"] = vals

    lines = []
    for label in ("SH", "ST", "SS", "DG", "CO"):
        rows = []
        vals = tables[label]
        for i in range(n):
            rows.append("    " + ", ".join(vals[i * n:(i + 1) * n]))
        body = ",\n".join(rows)
        comment = {
            "SH": "shallow line",
            "ST": "steep line",
            "SS": "steep + shallow (exact union)",
            "DG": "45-degree diagonal",
            "CO": "rounded corner",
        }[label]
        lines.append(f"// {comment}\nconst float {label}{n}[{n*n}] = float[{n*n}](\n{body}\n);")
    return "\n".join(lines)


def main():
    print("validating generator against Scaler2x..Scaler6x reference tables:")
    if not validate():
        raise SystemExit("REFERENCE VALIDATION FAILED")
    print("  all reference constants reproduced (waivers listed above)\n")

    for n in (7, 8):
        sh, st, ss, dg = line_tables(n)
        shn, stn, ssn, dgn = map(normalise, (sh, st, ss, dg))
        corner = corner_table(n)
        print(f"===== {n}x tables =====")
        for label, tbl in (("shallow", shn), ("steep", stn), ("sas", ssn), ("diag", dgn)):
            print(f"  {label}: " + ", ".join(
                f"({i},{j})={'set' if v == SET else v}" for (i, j), v in sorted(tbl.items())))
        ct, exact = corner
        print("  corner: " + ", ".join(
            f"({i},{j})={m}/100 ({exact[(i, j)]:.6f})" for (i, j), m in sorted(ct.items())))
        print()

        with open(os.path.join(WORK_DIR, f"scaler{n}x.rs"), "w") as f:
            f.write(emit_rust(n, shn, stn, ssn, dgn, corner))
        with open(os.path.join(WORK_DIR, f"glsl_tables_{n}x.txt"), "w") as f:
            f.write(emit_glsl_tables(n, shn, stn, ssn, dgn, corner))
    print("emitted: scaler7x.rs scaler8x.rs glsl_tables_7x.txt glsl_tables_8x.txt")


if __name__ == "__main__":
    main()
