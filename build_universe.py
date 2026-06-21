"""
Build the screener universe (universe.json) from one Nasdaq snapshot + curated
theme lists. Run occasionally (e.g. weekly):

    .venv/bin/python build_universe.py

The app reads the committed universe.json at runtime, so it never calls the
snapshot API live. One bulk request (no per-ticker throttling) returns the whole
market with sector/industry/marketCap; we filter and union:

    Nasdaq-100  ∪  software/SaaS (mktcap > $500M)  ∪  games  ∪  quantum

Each ticker is mapped to a sector/industry ETF for the idiosyncratic metric:
Nasdaq-100 keep their precise benchmark; software -> IGV, games -> XLC,
quantum -> SOXX.
"""

import json
import os
import urllib.request

from screener import NDX100_ETF

SNAPSHOT = "https://api.nasdaq.com/api/screener/stocks?tableonly=false&download=true"
HDRS = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "universe.json")
MIN_CAP = 500e6

SOFTWARE_INDUSTRIES = {
    "Computer Software: Prepackaged Software",
    "EDP Services",
    "Computer Software: Programming Data Processing",
}
GAMES = ["EA", "TTWO", "RBLX", "U", "APP", "SE", "BILI", "PLTK",
         "GDEV", "GRVY", "SKLZ", "NTES", "HUYA", "DOYU"]
QUANTUM = ["IONQ", "RGTI", "QBTS", "QUBT", "ARQQ", "LAES", "QSI", "QMCO"]


def _cap(r):
    try:
        return float(r["marketCap"])
    except (TypeError, ValueError, KeyError):
        return 0.0


def main():
    req = urllib.request.Request(SNAPSHOT, headers=HDRS)
    rows = json.load(urllib.request.urlopen(req, timeout=60))["data"]["rows"]
    present = {r["symbol"] for r in rows}

    uni = dict(NDX100_ETF)                       # Nasdaq-100 with precise benchmarks
    for r in rows:                               # software/SaaS > $500M -> IGV
        if r["industry"] in SOFTWARE_INDUSTRIES and _cap(r) > MIN_CAP:
            uni.setdefault(r["symbol"], "IGV")
    for t in GAMES:                              # games -> XLC
        if t in present:
            uni.setdefault(t, "XLC")
    for t in QUANTUM:                            # quantum -> SOXX
        if t in present:
            uni.setdefault(t, "SOXX")

    payload = {"min_cap": MIN_CAP, "count": len(uni), "tickers": uni}
    with open(OUT, "w") as fh:
        json.dump(payload, fh, indent=0, sort_keys=True)
    etfs = sorted({e for e in uni.values() if e})
    print(f"wrote {OUT}: {len(uni)} tickers, {len(etfs)} ETFs {etfs}")


if __name__ == "__main__":
    main()
