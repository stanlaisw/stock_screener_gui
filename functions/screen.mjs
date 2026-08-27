#!/usr/bin/env node
/**
 * Netlify Function: /api/screen  (JavaScript/Node — Netlify 只支援 JS/TS function)
 * 輸入: POST JSON { "symbols": "AAPL NVDA TSLA" }  或 GET ?q=AAPL,NVDA
 * 輸出: JSON { "rows": [...], "bench_ret3m": float, "error": str|null }
 *
 * 邏輯移植自原 screen.py：server 端拉 Yahoo chart API（避 CORS），
 * 純 JS 計指標 + 評分（max 8）。
 */

// ───────────────────────── 指標 (純 JS) ─────────────────────────
async function fetchYahoo(ticker, range = "2y", interval = "1d") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=${range}&interval=${interval}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`yahoo http ${res.status}`);
  const data = await res.json();
  const res0 = data?.chart?.result?.[0];
  if (!res0) throw new Error("no chart result");
  const q = res0.indicators.quote[0];
  const closes = q.close, highs = q.high, lows = q.low, vols = q.volume || [];
  const valid = [];
  for (let i = 0; i < closes.length; i++) {
    if (closes[i] != null && highs[i] != null && lows[i] != null) {
      valid.push([closes[i], highs[i], lows[i], (vols[i] != null ? vols[i] : 0)]);
    }
  }
  return {
    c: valid.map(v => v[0]),
    h: valid.map(v => v[1]),
    l: valid.map(v => v[2]),
    v: valid.map(v => v[3]),
  };
}

function sma(arr, n) {
  if (arr.length < n) return null;
  return arr.slice(-n).reduce((a, b) => a + b, 0) / n;
}

// 滾動 SMA，回同長度 array（前 n-1 位為 null），畀圖表畫 MA 線
function smaSeries(arr, n) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= n) sum -= arr[i - n];
    if (i >= n - 1) out[i] = round(sum / n, 2);
  }
  return out;
}

function rsi(arr, period = 14) {
  if (arr.length < period + 1) return null;
  const gains = [], losses = [];
  for (let i = 1; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  const ag = gains.slice(-period).reduce((a, b) => a + b, 0) / period;
  const al = losses.slice(-period).reduce((a, b) => a + b, 0) / period;
  if (al === 0) return 100.0;
  return 100 - 100 / (1 + ag / al);
}

function ema(vals, span) {
  const k = 2 / (span + 1);
  const out = [vals[0]];
  for (let i = 1; i < vals.length; i++) {
    out.push(vals[i] * k + out[out.length - 1] * (1 - k));
  }
  return out;
}

function macd(arr) {
  const e12 = ema(arr, 12), e26 = ema(arr, 26);
  const line = e12.map((v, i) => v - e26[i]);
  const sig = ema(line, 9);
  return [line[line.length - 1], sig[sig.length - 1]];
}

function atr(highs, lows, closes, period = 14) {
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  if (trs.length < period) return null;
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

const round = (x, d = 2) => {
  const m = Math.pow(10, d);
  return Math.round(x * m) / m;
};

// ───────────────────────── 評分 ─────────────────────────
async function screenOne(t, benchRet3m) {
  const { c, h, l, v } = await fetchYahoo(t);
  if (!c || c.length < 210) throw new Error("no data / <min bars");
  const ma50 = sma(c, 50), ma200 = sma(c, 200);
  const ma50s = smaSeries(c, 50), ma200s = smaSeries(c, 200);
  const r = rsi(c, 14);
  const [mline, msig] = macd(c);
  const cur = c[c.length - 1];
  const ret3m = c.length >= 63 ? (c[c.length - 1] / c[c.length - 63] - 1) * 100 : 0;
  const high52 = c.length >= 252 ? Math.max(...c.slice(-252)) : Math.max(...c);
  const distHigh = (cur / high52 - 1) * 100;
  const a = atr(h, l, c);
  const stop = a ? round(cur - 2.0 * a, 2) : null;
  const belowMa200 = ma200 ? cur < ma200 : false;

  let score = 0;
  if (ma50 && ma200 && ma50 > ma200) score += 2;
  if (r && r >= 40 && r <= 70) score += 1;
  if (mline > msig) score += 2;
  if (ret3m > benchRet3m) score += 1;
  if (distHigh >= -25.0 && distHigh < 0) score += 1;
  if (distHigh >= -15.0 && distHigh <= -3.0) score += 1;

  const W = 260;  // 畫圖窗口：夠長等 MA200 有連續線
  return {
    ticker: t.toUpperCase(),
    price: round(cur, 2),
    golden: !!(ma50 && ma200 && ma50 > ma200),
    ma50: ma50 ? round(ma50, 2) : null,
    ma200: ma200 ? round(ma200, 2) : null,
    rsi: r ? round(r, 1) : null,
    macd_bull: mline > msig,
    ret3m: round(ret3m, 1),
    rel_str: round(ret3m - benchRet3m, 1),
    dist_high: round(distHigh, 1),
    atr: a ? round(a, 2) : null,
    stop_loss: stop,
    below_ma200: belowMa200,
    score,
    series: c.slice(-W).map(x => round(x, 2)),
    volumes: v.slice(-W).map(x => Math.round(x)),
    ma50_series: ma50s.slice(-W),
    ma200_series: ma200s.slice(-W),
  };
}

async function runScreen(symbols) {
  let benchRet3m = 0.0;
  try {
    const bc = await fetchYahoo("SPY");
    benchRet3m = bc.c.length >= 63 ? (bc.c[bc.c.length - 1] / bc.c[bc.c.length - 63] - 1) * 100 : 0;
  } catch (_) { benchRet3m = 0.0; }

  const rows = [], errors = [];
  for (const s of symbols) {
    try {
      rows.push(await screenOne(s, benchRet3m));
    } catch (e) {
      errors.push({ ticker: s, error: String(e.message || e) });
    }
  }
  rows.sort((a, b) => b.score - a.score);
  return {
    rows,
    errors,
    bench_ret3m: round(benchRet3m, 1),
    count: rows.length,
  };
}

// ───────────────────────── Netlify Function entrypoint ─────────────────────────
export default async (req, context) => {
  try {
    let raw = "";
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      raw = body.symbols || body.q || "";
    } else {
      const url = new URL(req.url);
      raw = url.searchParams.get("q") || url.searchParams.get("symbols") || "";
    }
    const symbols = raw.replace(/,/g, " ").split(/\s+/).map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 30);
    if (!symbols.length) {
      return new Response(JSON.stringify({ error: "請提供至少一個 symbol，例如 AAPL NVDA" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    const data = await runScreen(symbols);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: `server error: ${e.message || e}` }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
};

// ── 本地測試用 (node netlify/functions/screen.mjs "AAPL NVDA") ──
if (process.argv[1] && process.argv[1].endsWith("screen.mjs")) {
  const syms = process.argv[2] || "AAPL NVDA TSLA";
  runScreen(syms.split(/\s+/).map(s => s.trim().toUpperCase()))
    .then(d => { console.log(JSON.stringify(d, null, 2)); })
    .catch(e => { console.error("ERR", e); process.exit(1); });
}
