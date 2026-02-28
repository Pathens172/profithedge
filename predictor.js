(function () {
  'use strict';

  // Use official Deriv WebSocket endpoint so prices
  // match the Deriv platforms exactly.
  const WS_URL = 'wss://ws.derivws.com/websockets/v3?app_id=1089';
  const SYMBOL_LABELS = {
    R_10: 'Volatility 10',
    R_10_1S: 'Volatility 10 (1s)',
    R_15_1S: 'Volatility 15 (1s)',
    R_25: 'Volatility 25',
    R_25_1S: 'Volatility 25 (1s)',
    R_30_1S: 'Volatility 30 (1s)',
    R_50: 'Volatility 50',
    R_50_1S: 'Volatility 50 (1s)',
    R_75: 'Volatility 75',
    R_75_1S: 'Volatility 75 (1s)',
    R_90_1S: 'Volatility 90 (1s)',
    R_100: 'Volatility 100',
  };
  const TICK_HISTORY_SIZE = 100;
  const DISPLAY_TICKS = 50;
  const PREDICTION_INTERVAL_MS = 15000;
  const HOT_STREAK_COUNT = 3;
  const HOT_STREAK_WINDOW = 10;
  const COLD_THRESHOLD = 15;
  const RSI_PERIOD = 14;
  const MACD_FAST = 12;
  const MACD_SLOW = 26;
  const MACD_SIGNAL = 9;
  const STOCH_K = 14;
  const STOCH_D = 3;

  const STORAGE_KEY = 'ph_digit_predictor_stats';

  function getStoredStats() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { wins: 0, total: 0, log: [] };
      return JSON.parse(raw);
    } catch {
      return { wins: 0, total: 0, log: [] };
    }
  }

  function saveStats(stats) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
    } catch (_) {}
  }

  // Extract last digit from the raw quote - no rounding, no scaling.
  // Deriv sends the exact price string; we use it verbatim so decimals stay identical.
  function lastDigitFromRawQuote(rawQuote) {
    const s = String(rawQuote).trim();
    for (let i = s.length - 1; i >= 0; i--) {
      const c = s[i];
      if (c >= '0' && c <= '9') return Number(c); // 0–9, including 0
    }
    return null;
  }

  // --- Technical indicators ---
  function ema(data, period) {
    if (!data.length || period < 1) return [];
    const k = 2 / (period + 1);
    const out = [];
    let prev = data[0];
    out[0] = prev;
    for (let i = 1; i < data.length; i++) {
      prev = data[i] * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  }

  function rsi(closes, period = RSI_PERIOD) {
    if (closes.length < period + 1) return null;
    let gains = 0;
    let losses = 0;
    for (let i = closes.length - period; i < closes.length - 1; i++) {
      const d = closes[i + 1] - closes[i];
      if (d > 0) gains += d;
      else losses -= d;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  function macd(closes, fast = MACD_FAST, slow = MACD_SLOW, signal = MACD_SIGNAL) {
    if (closes.length < slow) return null;
    const emaFast = ema(closes, fast);
    const emaSlow = ema(closes, slow);
    const macdLine = [];
    for (let i = 0; i < closes.length; i++) {
      macdLine.push((emaFast[i] ?? 0) - (emaSlow[i] ?? 0));
    }
    const signalLine = ema(macdLine.filter(Boolean), signal);
    const lastMacd = macdLine[macdLine.length - 1];
    const lastSignal = signalLine[signalLine.length - 1];
    return { macd: lastMacd, signal: lastSignal, histogram: lastMacd - lastSignal };
  }

  function stochastic(highs, lows, closes, kPeriod = STOCH_K, dPeriod = STOCH_D) {
    if (closes.length < kPeriod) return null;
    const lastClose = closes[closes.length - 1];
    const recentHigh = Math.max(...highs.slice(-kPeriod));
    const recentLow = Math.min(...lows.slice(-kPeriod));
    const range = recentHigh - recentLow;
    const k = range === 0 ? 50 : ((lastClose - recentLow) / range) * 100;
    return { k, d: k };
  }

  let ticks = [];
  let ws = null;
  let reconnectTimer = null;
  let predictionTimer = null;
  let countdownTimer = null;
  let countdownRemain = 15;
  let lastPrediction = null;
  let lastPredictionTime = 0;
  let isLive = true;

  const $ = (id) => document.getElementById(id);

  function updateWsStatus(text, ok) {
    const el = $('ws-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'text-xs px-2 py-1 rounded-full ' + (ok ? 'bg-green-900/50 text-green-400' : 'bg-slate-800 text-slate-400');
  }

  let currentSymbol = 'R_75';

  function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    updateWsStatus('Connecting…', false);
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      updateWsStatus(`Connected (${currentSymbol})`, true);
      ws.send(JSON.stringify({ ticks: currentSymbol, subscribe: 1 }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.tick) {
          const rawQuote = msg.tick.quote;
          const quoteNum = typeof rawQuote === 'number' ? rawQuote : parseFloat(rawQuote);
          const epoch = msg.tick.epoch || Date.now() / 1000;
          if (!Number.isFinite(quoteNum)) return;
          const digit = lastDigitFromRawQuote(rawQuote);
          if (digit === null) return;
          ticks.push({ quote: quoteNum, rawQuote: rawQuote, epoch, digit });
          if (ticks.length > TICK_HISTORY_SIZE) ticks.shift();

          updateLiveTick(rawQuote, digit);
          updateTickChart();
          updateTickList();
          updateDigitHeatmap();

          // Only settle on the first tick *after* 15 seconds since prediction.
          // That matches when a 15s Digit Match contract would expire.
          const now = Date.now();
          if (
            lastPrediction !== null &&
            lastPredictionTime > 0 &&
            now >= lastPredictionTime + PREDICTION_INTERVAL_MS
          ) {
            const stats = getStoredStats();
            stats.total += 1;
            if (digit === lastPrediction) stats.wins += 1;
            stats.log = (stats.log || []).slice(-99);
            stats.log.push({
              t: now,
              pred: lastPrediction,
              actual: digit,
              win: digit === lastPrediction,
            });
            saveStats(stats);
            lastPrediction = null;
            lastPredictionTime = 0;
            updateWinRate();
            updatePredictionsLog();
          }
        }
      } catch (_) {}
    };

    ws.onclose = () => {
      updateWsStatus('Disconnected', false);
      ws = null;
      if (isLive) reconnectTimer = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      updateWsStatus('Error', false);
    };
  }

  function updateLiveTick(rawQuote, digit) {
    const q = $('live-quote');
    const d = $('live-digit');
    if (q) q.textContent = rawQuote;
    if (d) d.textContent = digit;
  }

  function updateTickChart() {
    const container = $('tick-chart');
    if (!container) return;
    const slice = ticks.slice(-DISPLAY_TICKS);
    if (slice.length === 0) {
      container.innerHTML = '';
      return;
    }
    const min = Math.min(...slice.map((t) => t.quote));
    const max = Math.max(...slice.map((t) => t.quote));
    const range = max - min || 1;
    container.innerHTML = slice
      .map((t) => {
        const h = Math.max(2, (60 * (t.quote - min)) / range);
        const up = t.quote >= (slice[slice.indexOf(t) - 1]?.quote ?? t.quote);
        return `<div class="tick-bar flex-1 bg-slate-600 ${up ? 'bg-green-600/80' : 'bg-red-600/80'}" style="height:${h}%"></div>`;
      })
      .join('');
  }

  function updateTickList() {
    const container = $('tick-list');
    if (!container) return;
    const slice = [...ticks].reverse().slice(0, DISPLAY_TICKS);
    container.innerHTML = slice
      .map((t) => `<span class="px-1.5 py-0.5 rounded bg-slate-800 text-green-400 font-mono">${t.digit}</span>`)
      .join('');
  }

  function updateDigitHeatmap() {
    const container = $('digit-heatmap');
    if (!container) return;
    const slice = ticks.slice(-100);
    const freq = Array(10).fill(0);
    slice.forEach((t) => (freq[t.digit] += 1));
    const maxF = Math.max(...freq, 1);
    container.innerHTML = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
      .map((d) => {
        const pct = (freq[d] / maxF) * 100;
        const green = Math.round(20 + (pct / 100) * 180);
        return `<div class="digit-cell rounded-lg p-2 text-center font-mono font-bold text-white" style="background:rgb(0,${green},0);">${d}<br><span class="text-xs opacity-80">${freq[d]}</span></div>`;
      })
      .join('');
  }

  function updateWinRate() {
    const stats = getStoredStats();
    const w = $('win-rate');
    const p = $('win-rate-pct');
    if (w) w.textContent = `${stats.wins} / ${stats.total}`;
    if (p) {
      p.textContent = stats.total ? Math.round((100 * stats.wins) / stats.total) + '%' : '0%';
    }
  }

  function updatePredictionsLog() {
    const container = $('predictions-log');
    if (!container) return;
    const log = (getStoredStats().log || []).slice(-20).reverse();
    container.innerHTML = log
      .map((e) => {
        const time = new Date(e.t).toLocaleTimeString();
        const res = e.win ? 'text-green-400' : 'text-red-400';
        return `<div>${time} pred=${e.pred} actual=${e.actual} <span class="${res}">${e.win ? 'WIN' : 'LOSS'}</span></div>`;
      })
      .join('');
  }

  function runPrediction() {
    if (ticks.length < 25) {
      $('pred-digit').textContent = '—';
      $('pred-confidence').textContent = 'Confidence: —%';
      const td = $('trade-digit');
      if (td) td.textContent = '—';
      return;
    }

    const digits = ticks.map((t) => t.digit);
    const lastDigit = digits[digits.length - 1];
    const prob = Array(10).fill(1e-9);

    // 1) Weighted frequency: very recent counts most (last 5, 15, 30, 60)
    const n5 = digits.slice(-5);
    const n15 = digits.slice(-15);
    const n30 = digits.slice(-30);
    const n60 = digits.slice(-60);
    for (let d = 0; d <= 9; d++) {
      const f5 = n5.filter((x) => x === d).length / 5;
      const f15 = n15.filter((x) => x === d).length / 15;
      const f30 = n30.filter((x) => x === d).length / 30;
      const f60 = n60.filter((x) => x === d).length / Math.max(n60.length, 1);
      prob[d] += 0.45 * f5 + 0.30 * f15 + 0.15 * f30 + 0.10 * f60;
    }

    // 2) Markov: P(next digit | last digit) from last 50 transitions
    const transitions = [];
    for (let i = 0; i < digits.length - 1; i++) transitions.push({ from: digits[i], to: digits[i + 1] });
    const last50 = transitions.slice(-50);
    const followCount = Array(10).fill(0);
    last50.forEach((tr) => {
      if (tr.from === lastDigit) followCount[tr.to]++;
    });
    const followSum = followCount.reduce((a, b) => a + b, 0) || 1;
    for (let d = 0; d <= 9; d++) prob[d] += 0.25 * (followCount[d] / followSum);

    // 3) Hot digits: appeared 2+ times in last 8 ticks
    const last8 = digits.slice(-8);
    for (let d = 0; d <= 9; d++) {
      if (last8.filter((x) => x === d).length >= 2) prob[d] *= 1.15;
    }

    // 4) Cold / mean reversion: digit absent 12+ ticks gets small boost
    for (let d = 0; d <= 9; d++) {
      let idx = -1;
      for (let i = digits.length - 1; i >= 0; i--) {
        if (digits[i] === d) {
          idx = i;
          break;
        }
      }
      const dist = idx >= 0 ? digits.length - 1 - idx : 999;
      if (dist >= 12) prob[d] *= 1.08;
    }

    const sum = prob.reduce((a, b) => a + b, 0) || 1;
    for (let d = 0; d <= 9; d++) prob[d] = prob[d] / sum;

    let best = 0;
    let bestP = 0;
    for (let d = 0; d <= 9; d++) {
      if (prob[d] > bestP) {
        bestP = prob[d];
        best = d;
      }
    }

    const sorted = [...prob].sort((a, b) => b - a);
    const second = sorted[1] || 0;
    const confidence = Math.min(100, Math.round((bestP + (bestP - second)) * 100));

    lastPrediction = best;
    lastPredictionTime = Date.now();

    $('pred-digit').textContent = best;
    $('pred-confidence').textContent = `Confidence: ${confidence}%`;
    const td = $('trade-digit');
    if (td) td.textContent = String(best);

    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.15);
    } catch (_) {}
    if (navigator.vibrate) navigator.vibrate(50);
  }

  function startCountdown() {
    countdownRemain = 15;
    const timerEl = $('timer-sec');
    const arcEl = $('timer-arc');
    if (timerEl) timerEl.textContent = '15';
    if (arcEl) arcEl.style.strokeDashoffset = '100';

    countdownTimer = setInterval(() => {
      countdownRemain -= 1;
      if (timerEl) timerEl.textContent = String(countdownRemain);
      if (arcEl) arcEl.style.strokeDashoffset = String(100 - (100 * (15 - countdownRemain)) / 15);
      if (countdownRemain <= 0) {
        clearInterval(countdownTimer);
        runPrediction();
        startCountdown();
      }
    }, 1000);
  }

  function init() {
    connect();
    updateWinRate();
    updatePredictionsLog();

    const symSelect = $('symbol-select');
    if (symSelect) {
      symSelect.value = currentSymbol;
      const ts = $('trade-symbol');
      if (ts) ts.textContent = `${SYMBOL_LABELS[currentSymbol] || currentSymbol} (${currentSymbol})`;

      symSelect.addEventListener('change', (e) => {
        currentSymbol = e.target.value;
        ticks = [];
        updateTickChart();
        updateTickList();
        updateDigitHeatmap();
        updateLiveTick('—', '—');
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (ws) {
          ws.close();
          ws = null;
        }
        const ts2 = $('trade-symbol');
        if (ts2) ts2.textContent = `${SYMBOL_LABELS[currentSymbol] || currentSymbol} (${currentSymbol})`;
        connect();
      });
    }

    $('auto-play').addEventListener('change', (e) => {
      isLive = e.target.checked;
      if (isLive) connect();
      else if (ws) {
        ws.close();
        ws = null;
        if (reconnectTimer) clearTimeout(reconnectTimer);
      }
    });

    const resetBtn = $('reset-stats');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        saveStats({ wins: 0, total: 0, log: [] });
        updateWinRate();
        updatePredictionsLog();
      });
    }

    setTimeout(() => {
      startCountdown();
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
