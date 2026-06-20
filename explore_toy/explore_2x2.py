"""
Demo of the 4 top-level Explore panels, rendered SEPARATELY.
Position label (TL/TR/BL/BR) goes in each figure header.

Global encodings (identical across all 4 panels):
    color = drift  (diverging: red=downtrend/falling-knife, yellow=flat=GOOD, green=uptrend)
    size  = annualized volatility (bigger = bigger swings)

Panels:
    TL Character : X=upswing count        Y=R^2 of log-price trend
    TR Payoff    : X=backtest win rate     Y=backtest avg return/trade
    BL Value     : X=ripeness (% below mean) Y=drawdown-from-high (valuation STUB)
    BR Factor    : X=idiosyncratic residual z-score vs industry ETF  Y=ripeness
"""

import numpy as np
import pandas as pd
import yfinance as yf
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.colors as mcolors
import warnings
warnings.filterwarnings("ignore")

def linregress_np(x, y):
    """Returns (slope, intercept, rvalue) — numpy replacement for scipy.stats.linregress."""
    x = np.asarray(x, dtype=float); y = np.asarray(y, dtype=float)
    slope, intercept = np.polyfit(x, y, 1)
    r = np.corrcoef(x, y)[0, 1]
    return slope, intercept, r

THRESHOLD      = 0.40
LOOKBACK_YEARS = 3
BT_TP, BT_SL, BT_HOLD = 1.40, 0.60, 126
IDIO_WINDOW    = 60   # trading days for the "off" residual

# ── Universe + industry→ETF assignment ───────────────────────────────────────
# (auto-seedable from yfinance .info['industry'] later; hand-coded here for the demo)
IND = {
    # Semiconductors → SOXX
    "NVDA":"SOXX","AVGO":"SOXX","AMD":"SOXX","QCOM":"SOXX","TXN":"SOXX","AMAT":"SOXX",
    "MU":"SOXX","LRCX":"SOXX","ADI":"SOXX","KLAC":"SOXX","MRVL":"SOXX","NXPI":"SOXX",
    "MCHP":"SOXX","ON":"SOXX","ASML":"SOXX","SMCI":"SOXX",
    # Software / SaaS → IGV
    "MSFT":"IGV","INTU":"IGV","PANW":"IGV","SNPS":"IGV","CDNS":"IGV","CRWD":"IGV",
    "TEAM":"IGV","WDAY":"IGV","FTNT":"IGV","DDOG":"IGV","ZS":"IGV","ANSS":"IGV",
    "MDB":"IGV","OKTA":"IGV","NET":"IGV","SNOW":"IGV","ADBE":"IGV","ASAN":"IGV",
    "PATH":"IGV","SHOP":"IGV","NOW":"IGV","ORCL":"IGV","ADSK":"IGV","CTSH":"IGV","ZM":"IGV",
    # Comm services / media → XLC
    "GOOGL":"XLC","GOOG":"XLC","META":"XLC","NFLX":"XLC","CMCSA":"XLC","WBD":"XLC",
    "EA":"XLC","TTWO":"XLC","TTD":"XLC","SIRI":"XLC","TMUS":"XLC",
    # Consumer discretionary → XLY
    "AMZN":"XLY","TSLA":"XLY","BKNG":"XLY","SBUX":"XLY","MAR":"XLY","ABNB":"XLY",
    "ORLY":"XLY","ROST":"XLY","DLTR":"XLY","MELI":"XLY","DASH":"XLY","UBER":"XLY",
    # Consumer staples → XLP
    "COST":"XLP","PEP":"XLP","MDLZ":"XLP","KDP":"XLP","KHC":"XLP","MNST":"XLP",
    # Biotech / health → XBI
    "AMGN":"XBI","GILD":"XBI","REGN":"XBI","VRTX":"XBI","DXCM":"XBI","IDXX":"XBI",
    "BIIB":"XBI","ILMN":"XBI","ALGN":"XBI","GEHC":"XBI","AZN":"XBI",
    # Industrials → XLI
    "HON":"XLI","CSX":"XLI","PCAR":"XLI","ODFL":"XLI","FAST":"XLI","CPRT":"XLI",
    "VRSK":"XLI","PAYX":"XLI","ADP":"XLI","CTAS":"XLI","ROP":"XLI",
    # Energy / utilities / materials / fintech / solar / hardware
    "FANG":"XLE","CEG":"XLU","EXC":"XLU","LIN":"XLB","PYPL":"IPAY","ENPH":"TAN",
    "AAPL":"XLK","CSCO":"XLK",
}
STOCKS = list(IND.keys())
ETFS   = sorted(set(IND.values()))
ALL    = STOCKS + ETFS

# ── Download ──────────────────────────────────────────────────────────────────
print(f"Downloading {len(STOCKS)} stocks + {len(ETFS)} ETFs …")
end   = pd.Timestamp.today()
start = end - pd.DateOffset(years=LOOKBACK_YEARS)
raw   = yf.download(ALL, start=start.strftime("%Y-%m-%d"),
                    end=end.strftime("%Y-%m-%d"), auto_adjust=True, progress=True)
close = raw["Close"]
print(f"Got {close.shape[1]} columns, {len(close)} bars.\n")

# ── Zigzag (alternating, corrected) ──────────────────────────────────────────
def zigzag_alternating(series, threshold=0.40):
    s = series.dropna(); arr = s.values.astype(float); dates = s.index; n = len(arr)
    if n < 40: return []
    pivots=[]; direction=0; cand_val=arr[0]; cand_idx=0; init=False
    for i in range(1,n):
        p=float(arr[i])
        if not init:
            if p>cand_val: cand_val=p; cand_idx=i
            if cand_val/arr[0]-1>=threshold:
                sub=arr[:i+1]; mx=int(np.argmax(sub))
                mb=float(np.min(sub[:mx+1])) if mx>0 else float(arr[0])
                mbi=int(np.argmin(sub[:mx+1])) if mx>0 else 0
                pivots+=[{'price':mb,'kind':'L'},{'price':float(sub[mx]),'kind':'H'}]
                direction=-1; cand_val=p; cand_idx=i; init=True; continue
            sub=arr[:i+1]; mn=float(np.min(sub))
            if arr[0]/mn-1>=threshold:
                pivots+=[{'price':float(arr[0]),'kind':'H'},{'price':mn,'kind':'L'}]
                direction=1; cand_val=p; cand_idx=i; init=True; continue
        else:
            if direction==1:
                if p>cand_val: cand_val=p; cand_idx=i
                elif cand_val/p-1>=threshold:
                    pivots.append({'price':cand_val,'kind':'H'}); direction=-1; cand_val=p; cand_idx=i
            else:
                if p<cand_val: cand_val=p; cand_idx=i
                elif p/cand_val-1>=threshold:
                    pivots.append({'price':cand_val,'kind':'L'}); direction=1; cand_val=p; cand_idx=i
    return pivots

def count_upswings(pivots):
    return sum(1 for i in range(len(pivots)-1)
               if pivots[i]['kind']=='L' and pivots[i+1]['kind']=='H')

def run_backtest(arr, tp=BT_TP, sl=BT_SL, hold=BT_HOLD):
    n=len(arr); rets=[]
    for i in range(n-1):
        entry=arr[i]; r=None
        for j in range(i+1, min(i+hold+1, n)):
            rr=arr[j]/entry
            if rr>=tp: r=(rr-1)*100; break
            if rr<=sl: r=(rr-1)*100; break
        if r is None: r=(arr[min(i+hold,n-1)]/entry-1)*100
        rets.append(r)
    if not rets: return np.nan, np.nan
    a=np.array(rets); return float(a.mean()), float((a>0).mean())

# ── Metrics ───────────────────────────────────────────────────────────────────
rows=[]
for sym in STOCKS:
    col=close.get(sym)
    if col is None: continue
    s=col.squeeze().dropna()
    if len(s)<150: continue
    arr=s.values.astype(float)
    logret=np.log(s/s.shift(1)).dropna()
    ann_vol=float(logret.std()*np.sqrt(252)*100)
    t=np.arange(len(s))/252.0
    slope,intc,rval=linregress_np(t, np.log(arr))
    drift=float(slope*100); r2=float(rval**2)
    up=count_upswings(zigzag_alternating(s, THRESHOLD))
    mean_p=float(s.mean()); last=float(arr[-1]); mx=float(arr.max())
    ripeness=(mean_p-last)/mean_p*100
    dd=(mx-last)/mx*100
    win=min(252,len(arr)); high52=float(arr[-win:].max())
    off52=(high52-last)/high52*100          # % below 52-week high (bounded 0-100)
    bt_avg,bt_win=run_backtest(arr)
    # idiosyncratic residual z-score vs assigned industry ETF
    etf=IND[sym]; ecol=close.get(etf)
    idio_z=np.nan
    if ecol is not None:
        e=ecol.squeeze().dropna()
        common=s.index.intersection(e.index)
        if len(common)>IDIO_WINDOW+20:
            sr=np.log(s.loc[common]/s.loc[common].shift(1)).dropna()
            er=np.log(e.loc[common]/e.loc[common].shift(1)).dropna()
            idx=sr.index.intersection(er.index)
            sr=sr.loc[idx]; er=er.loc[idx]
            beta,_,_=linregress_np(er.values, sr.values)
            resid=sr.values - beta*er.values
            recent=resid[-IDIO_WINDOW:]
            sd=resid.std()
            idio_z=float(recent.sum()/(sd*np.sqrt(IDIO_WINDOW))) if sd>0 else np.nan
    rows.append(dict(sym=sym, ind=etf, ann_vol=ann_vol, drift=drift, r2=r2,
                     up=up, ripeness=ripeness, dd=dd, off52=off52,
                     bt_avg=bt_avg, bt_win=bt_win, idio_z=idio_z))

df=pd.DataFrame(rows).set_index("sym")
print(f"{len(df)} stocks scored.\n")
print(df.round(2).to_string())

# ── Plot styling ──────────────────────────────────────────────────────────────
DARK="#0e0e0f"; PANEL="#22242a"; TXT="#c6c7ca"; GRID="#333640"
df_v=df.dropna(subset=["drift","ann_vol"])

# global color norm (drift) and size (vol), shared across panels
d=df_v["drift"]
cmin=float(np.nanpercentile(d,5)); cmax=float(np.nanpercentile(d,95))
cnorm=mcolors.TwoSlopeNorm(vmin=min(cmin,-0.1), vcenter=0, vmax=max(cmax,0.1))
def sizes(sub): return np.clip(sub["ann_vol"].values*5.0, 30, 500)

def render(sub, xcol, ycol, pos, title, xlabel, ylabel, fname,
           xclip=None, vlines=None, hlines=None):
    fig, ax = plt.subplots(figsize=(13,10))
    fig.patch.set_facecolor(DARK); ax.set_facecolor(PANEL)
    for sp in ax.spines.values(): sp.set_edgecolor(GRID)
    ax.grid(True, color=GRID, lw=0.5, ls="--")
    ax.tick_params(colors=TXT)

    x=sub[xcol].values.copy()
    if xclip is not None:
        x=np.clip(x, xclip[0], xclip[1])
    sc=ax.scatter(x, sub[ycol].values, s=sizes(sub), c=sub["drift"].values,
                  cmap="RdYlGn", norm=cnorm, alpha=0.85,
                  edgecolors=TXT, linewidths=0.4, zorder=3)
    for sym,xx,yy in zip(sub.index, x, sub[ycol].values):
        ax.annotate(sym, xy=(xx,yy), xytext=(3,3), textcoords="offset points",
                    fontsize=6, color=TXT, alpha=0.85, zorder=4)
    if vlines:
        for v in vlines: ax.axvline(v, color="#88889a", lw=0.8, ls="--", alpha=0.6)
    if hlines:
        for h in hlines: ax.axhline(h, color="#88889a", lw=0.8, ls="--", alpha=0.6)

    cb=fig.colorbar(sc, ax=ax, pad=0.02)
    cb.set_label("GLOBAL color = drift %/yr (red=falling knife, yellow=flat=GOOD, green=uptrend)",
                 color=TXT, fontsize=8)
    cb.ax.yaxis.set_tick_params(color=TXT)
    plt.setp(cb.ax.yaxis.get_ticklabels(), color=TXT, fontsize=7)

    # size legend
    for vol,lab in [(30,"30% vol"),(60,"60% vol"),(100,"100% vol")]:
        ax.scatter([],[],s=vol*5.0,c="gray",alpha=0.5,edgecolors=TXT,linewidths=0.3,label=lab)
    leg=ax.legend(title="GLOBAL size = volatility", title_fontsize=7, fontsize=7,
                  loc="upper left", facecolor=PANEL, edgecolor=GRID, labelcolor=TXT)
    leg.get_title().set_color(TXT)

    ax.set_title(f"[{pos}]  {title}", color=TXT, fontsize=13, pad=10, loc="left", fontweight="bold")
    ax.set_xlabel(xlabel, color=TXT, fontsize=9)
    ax.set_ylabel(ylabel, color=TXT, fontsize=9)
    plt.tight_layout()
    out=f"/home/mtrencseni/stocks/explore_toy/{fname}"
    fig.savefig(out, dpi=130, bbox_inches="tight", facecolor=DARK); plt.close(fig)
    print(f"Saved {out}")

# TL — Character
render(df_v.dropna(subset=["up","r2"]), "up","r2","TL",
       "Character — 'Is this my kind of stock?'",
       "Confirmed upswings (≥40% L→H) in 3y  (more = swings more often)",
       "R² of log-price trend  (LOW = choppy/rangebound = GOOD,  high = clean trend)",
       "panel_TL_character.png")

# TR — Payoff
render(df_v.dropna(subset=["bt_win","bt_avg"]), "bt_win","bt_avg","TR",
       "Payoff — 'Does my strategy actually pay?'",
       "Backtest win rate  (fraction of trades > 0)",
       "Backtest avg return / trade (%)   [TP+40% / SL-40% / max 6mo hold]",
       "panel_TR_payoff.png", hlines=[0])

# BL — Value
render(df_v.dropna(subset=["off52","dd"]), "off52","dd","BL",
       "Value — 'Is it cheap right now, for real?'",
       "% below 52-week high  (right = more depressed)",
       "Drawdown from 3y high (%)   [STUB for valuation — real axis = P/E or P/S vs own history]",
       "panel_BL_value.png")

# BR — Factor / off
render(df_v.dropna(subset=["idio_z","off52"]), "idio_z","off52","BR",
       "Factor / 'off' — 'Is the dip its own, and is it ripe?'",
       "Idiosyncratic residual z-score vs industry ETF  (LEFT = off-to-downside = GOOD)",
       "% below 52-week high  (up = more depressed)",
       "panel_BR_factor.png", vlines=[0])

print("\nDone.")
