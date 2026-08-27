#!/usr/bin/env python3
"""
Netlify Function: /api/screen
輸入: POST JSON { "symbols": "AAPL NVDA TSLA" }  或 GET ?q=AAPL,NVDA
輸出: JSON { "rows": [...], "bench_ret3m": float, "error": str|null }

server 端拉 Yahoo chart API (避開瀏覽器 CORS)，用純 stdlib 計指標 + 評分。
評分邏輯移植自 Stanley 嘅 us_screener.py (max 8)：
  +2 黃金交叉 (MA50 > MA200)
  +1 RSI(14) 健康 (40 <= RSI <= 70)
  +2 MACD 牛 (MACD line > signal)
  +1 相對強度: 3mo return > 基準(SPY) 3mo return
  +1 水位: -25% <= price vs 52w high < 0
  +1 獎勵: 水位理想 band -15%..-3%
風險位: ATR(14) 止損 (-2xATR)，穿 MA200 = invalidation flag
"""

import json
import urllib.request
from urllib.parse import urlparse, parse_qs

# ───────────────────────── 指標 (純 stdlib) ─────────────────────────
def fetch_yahoo(ticker, range_="2y", interval="1d"):
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
           f"?range={range_}&interval={interval}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.load(r)
    res = data["chart"]["result"][0]
    q = res["indicators"]["quote"][0]
    closes = q["close"]; highs = q["high"]; lows = q["low"]
    valid = [(c, h, l) for c, h, l in zip(closes, highs, lows)
             if c is not None and h is not None and l is not None]
    return [v[0] for v in valid], [v[1] for v in valid], [v[2] for v in valid]


def sma(arr, n):
    if len(arr) < n:
        return None
    return sum(arr[-n:]) / n


def rsi(arr, period=14):
    if len(arr) < period + 1:
        return None
    gains = []; losses = []
    for i in range(1, len(arr)):
        d = arr[i] - arr[i-1]
        gains.append(max(d, 0)); losses.append(max(-d, 0))
    ag = sum(gains[-period:]) / period
    al = sum(losses[-period:]) / period
    if al == 0:
        return 100.0
    return 100 - 100 / (1 + ag / al)


def macd(arr):
    def ema(vals, span):
        k = 2 / (span + 1); out = [vals[0]]
        for v in vals[1:]:
            out.append(v * k + out[-1] * (1 - k))
        return out
    e12 = ema(arr, 12); e26 = ema(arr, 26)
    line = [a - b for a, b in zip(e12, e26)]
    sig = ema(line, 9)
    return line[-1], sig[-1]


def atr(highs, lows, closes, period=14):
    trs = []
    for i in range(1, len(closes)):
        tr = max(highs[i] - lows[i],
                 abs(highs[i] - closes[i-1]),
                 abs(lows[i] - closes[i-1]))
        trs.append(tr)
    if len(trs) < period:
        return None
    return sum(trs[-period:]) / period


# ───────────────────────── 評分 ─────────────────────────
def screen_one(t, bench_ret3m, cfg=None):
    c, h, l = fetch_yahoo(t)
    if not c or len(c) < 210:
        raise ValueError("no data / <min bars")
    ma50 = sma(c, 50); ma200 = sma(c, 200)
    r = rsi(c, 14)
    mline, msig = macd(c)
    cur = c[-1]
    ret3m = (c[-1] / c[-63] - 1) * 100 if len(c) >= 63 else 0.0
    high52 = max(c[-252:]) if len(c) >= 252 else max(c)
    dist_high = (cur / high52 - 1) * 100
    a = atr(h, l, c)
    stop = round(cur - 2.0 * a, 2) if a else None
    below_ma200 = bool(cur < ma200) if ma200 else False

    score = 0
    if ma50 and ma200 and ma50 > ma200: score += 2
    if r and 40 <= r <= 70: score += 1
    if mline > msig: score += 2
    if ret3m > bench_ret3m: score += 1
    if -25.0 <= dist_high < 0: score += 1
    if -15.0 <= dist_high <= -3.0: score += 1

    return {
        "ticker": t.upper(),
        "price": round(cur, 2),
        "golden": bool(ma50 and ma200 and ma50 > ma200),
        "ma50": round(ma50, 2) if ma50 else None,
        "ma200": round(ma200, 2) if ma200 else None,
        "rsi": round(r, 1) if r else None,
        "macd_bull": bool(mline > msig),
        "ret3m": round(ret3m, 1),
        "rel_str": round(ret3m - bench_ret3m, 1),
        "dist_high": round(dist_high, 1),
        "atr": round(a, 2) if a else None,
        "stop_loss": stop,
        "below_ma200": below_ma200,
        "score": score,
        "series": [round(x, 2) for x in c[-120:]],   # 畀 frontend 畫圖 (近120日)
    }


def handler(event, context):
    """Netlify Function entrypoint."""
    try:
        # 解析輸入
        if event.get("httpMethod") == "POST":
            body = json.loads(event.get("body") or "{}")
            raw = body.get("symbols") or body.get("q") or ""
        else:
            qs = parse_qs(urlparse(event.get("rawUrl", event.get("path", ""))).query)
            raw = (qs.get("q") or qs.get("symbols") or [""])[0]
        symbols = [s.strip().upper() for s in raw.replace(",", " ").split() if s.strip()]
        symbols = symbols[:30]  # 防濫用
        if not symbols:
            return _resp(400, {"error": "請提供至少一個 symbol，例如 AAPL NVDA"})

        # 基準 (SPY) 3mo return
        try:
            bc, _, _ = fetch_yahoo("SPY")
            bench_ret3m = (bc[-1] / bc[-63] - 1) * 100 if len(bc) >= 63 else 0.0
        except Exception:
            bench_ret3m = 0.0

        rows = []
        errors = []
        for s in symbols:
            try:
                rows.append(screen_one(s, bench_ret3m))
            except Exception as e:
                errors.append({"ticker": s, "error": str(e)})

        rows.sort(key=lambda r: r["score"], reverse=True)
        return _resp(200, {
            "rows": rows,
            "errors": errors,
            "bench_ret3m": round(bench_ret3m, 1),
            "count": len(rows),
        })
    except Exception as e:
        return _resp(500, {"error": f"server error: {e}"})


def _resp(code, obj):
    return {
        "statusCode": code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        "body": json.dumps(obj, ensure_ascii=False),
    }


# ───────────────────────── Netlify 官方格式 (新版) ─────────────────────────
# 同時支援舊式 AWS Lambda handler(event, context) 做 back-compat。
try:
    from netlify.function import Function, Request, Response

    class Handler(Function):
        def on_post(self, req: Request) -> Response:
            try:
                body = json.loads(req.body) if isinstance(req.body, (str, bytes)) else {}
                if isinstance(req.body, bytes):
                    body = json.loads(req.body.decode())
            except Exception:
                body = {}
            event = {
                "httpMethod": "POST",
                "body": json.dumps(body),
                "rawUrl": "",
            }
            out = handler(event, None)
            return Response(
                body=out["body"],
                status=out["statusCode"],
                headers=out["headers"],
            )

        def on_get(self, req: Request) -> Response:
            qs = req.query_string.decode() if isinstance(req.query_string, bytes) else (req.query_string or "")
            from urllib.parse import parse_qs
            parsed = parse_qs(qs)
            raw = (parsed.get("q") or parsed.get("symbols") or [""])[0]
            event = {"httpMethod": "GET", "body": "", "rawUrl": "/api/screen?" + qs}
            out = handler(event, None)
            return Response(body=out["body"], status=out["statusCode"], headers=out["headers"])
except ImportError:
    # netlify.function 唔喺本地 import 到（正常），keep handler 模式就得
    pass


# ── 本地測試用 (python functions/screen.py) ──
if __name__ == "__main__":
    import sys
    syms = sys.argv[1] if len(sys.argv) > 1 else "AAPL NVDA TSLA"
    class _Ev(dict):
        def __init__(self, **kw):
            super().__init__(**kw)
            self["httpMethod"] = "POST"
            self["body"] = json.dumps({"symbols": syms})
            self["rawUrl"] = ""
    class _Ctx: pass
    out = handler(_Ev(), _Ctx())
    print(out["body"])
