# 美股技術 Screen GUI（Netlify Serverless）

純 event-driven，**唔使部機常駐跑**。你 browser/phone 開 index.html → 入 symbol →
call Netlify Function（Python，server 端拉 Yahoo 數據 + 計分）→ 返 JSON → 前端 table + Chart.js 出圖。

## 計分 logic（max 8，移植自 us_screener.py）
- +2 黃金交叉 (MA50 > MA200)
- +1 RSI(14) 健康 (40 ≤ RSI ≤ 70)
- +2 MACD 牛 (MACD line > signal)
- +1 相對強度：3mo return > SPY 3mo return
- +1 水位：-25% ≤ price vs 52w high < 0
- +1 獎勵：水位理想 band -15%..-3%
- 風險位：ATR(14) 止損 = −2×ATR；收市穿 MA200 = invalidation flag

## 本地測試（唔使部署）
```bash
# 直接跑 function logic（模擬 Netlify event）
python3 functions/screen.py "AAPL NVDA TSLA HOOD"
```

## 部署上 Netlify（free）
方法 A — 拖文件（最簡單，零 CLI）：
1. 去 https://app.netlify.com/drop
2. 拖 `stock_screener_gui/` 成個 folder 落去
3. 等 deploy 完，拎到個 `*.netlify.app` 網址就得

方法 B — Git 連接（之後 push 自動 redeploy）：
1. `cd ~/proj/stock_screener_gui`
2. `git init && git add -A && git commit -m "stock screener gui"`
3. 推上 GitHub（stanlisw repo 或新 repo）
4. Netlify → "New site from Git" → 選 repo → Build command 留空、Publish dir = `public`
5. Functions dir 會 auto-detect `functions/`

## 注意
- Yahoo chart API 有 rate limit，短時間狂掃幾十隻可能部分 skip（function 會喺 errors 列出）。
- 免費 Netlify 有 function 執行秒數上限（呢度 set 咗 26s），一次掃太多隻會 timeout；建議一次 10–15 隻內。
- 唔使 Friday 跑任何嘢，純 static + serverless。
