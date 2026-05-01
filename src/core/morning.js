/**
 * Morning brief + EDGE command — chart-first SMC scoring engine.
 *
 * EDGE is the primary trading tool. It reads ALL TradingView indicator data:
 *   - Study values (breakout channels, IFVG exhaustion signals)
 *   - Pine labels (BOS/CHoCH from LuxAlgo SMC, sweep labels)
 *   - Pine lines (order block levels, BSL/SSL levels)
 *   - Pine boxes (FVG zones, OB zones from Sonarlab/LuxAlgo)
 *
 * Scoring is chart-first, options-second:
 *   Step 1: Regime gate (SPY + QQQ breakout channels)
 *   Step 2: Chart signal scoring (3+ required from 6 categories)
 *   Step 3: Options confirmation (sizing/timing only)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as chart from "./chart.js";
import * as data from "./data.js";
import * as watchlistCore from "./watchlist.js";
import * as options from "./options.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../");
const SESSIONS_DIR = join(homedir(), ".tradingview-mcp", "sessions");

// --- Indicator name patterns for signal extraction ---
const INDICATOR_PATTERNS = {
  breakoutChannel: /breakout.?channel|algoalpha/i,
  smcLuxalgo: /smart.?money.?concepts?\s*\[?luxalgo/i,
  liquiditySweep: /liquidity.?sweep/i,
  orderBlockSonarlab: /sonarlab.*order.?block/i,
  orderBlockLuxalgo: /order.?block.*(?:detector|luxalgo)/i,
  fvgExpo: /institutional.?fvg|liquidity.?range|expo/i,
  fvgBigBeluga: /fvg.*bigbeluga|bigbeluga.*fvg/i,
  bslSsl: /buyside.*sellside|sellside.*buyside|bsl.*ssl/i,
  volume: /^volume$/i,
};

// --- Helper: load rules.json ---
function loadRules(rulesPath) {
  const candidates = [
    rulesPath,
    join(PROJECT_ROOT, "rules.json"),
    join(homedir(), ".tradingview-mcp", "rules.json"),
  ].filter(Boolean);

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return { rules: JSON.parse(readFileSync(p, "utf8")), path: p };
      } catch (e) {
        throw new Error(`Failed to parse rules.json at ${p}: ${e.message}`);
      }
    }
  }

  throw new Error(
    "No rules.json found. Copy rules.example.json to rules.json and fill in your trading rules.\n" +
      "Looked in:\n" +
      candidates
        .filter(Boolean)
        .map((p) => `  - ${p}`)
        .join("\n"),
  );
}

// --- Yahoo pre-screener ---
async function fetchYahooScreeners(screenIds = ["day_gainers", "day_losers", "most_actives"], maxPerScreen = 15) {
  const results = [];
  for (const scrId of screenIds) {
    const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&scrIds=${scrId}&count=${maxPerScreen}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const json = await res.json();
      const quotes = json?.finance?.result?.[0]?.quotes || [];
      for (const q of quotes) {
        const symbol = q.symbol;
        const price = q.regularMarketPrice;
        const changePct = q.regularMarketChangePercent;
        const change = q.regularMarketChange;
        if (!symbol || price == null || changePct == null) continue;
        results.push({
          symbol,
          price: Number(price).toFixed(2),
          change: Number(change ?? 0).toFixed(2),
          gapPct: Number(changePct).toFixed(2),
          absGap: Math.abs(Number(changePct)),
          source: `yahoo:${scrId}`,
        });
      }
    } catch (_) {
      continue;
    }
  }
  return results;
}

// --- Pre-screener ---
async function preScreen(coreWatchlist, threshold = 1.5, maxExtras = 3, externalConfig = {}) {
  const allMovers = [];
  const seen = new Set();
  let tvCount = 0;
  let yahooCount = 0;
  const sourceErrors = [];

  // Source 1: TradingView watchlist panel
  try {
    const watchlistData = await watchlistCore.get();
    const symbols = watchlistData?.symbols || [];
    tvCount = symbols.length;

    for (const item of symbols) {
      const sym = item.symbol || "";
      const changePct = parseFloat((item.change_percent || "").replace("%", ""));
      const change = parseFloat((item.change || "").replace(/,/g, ""));
      const last = parseFloat((item.last || "").replace(/,/g, ""));

      if (isNaN(changePct) || isNaN(last)) continue;
      const cleanSymbol = sym.includes(":") ? sym.split(":")[1] : sym;
      if (coreWatchlist.includes(cleanSymbol)) continue;

      const absGap = Math.abs(changePct);
      if (absGap >= threshold && !seen.has(cleanSymbol)) {
        seen.add(cleanSymbol);
        allMovers.push({
          symbol: cleanSymbol,
          fullSymbol: sym,
          price: last.toFixed(2),
          change: change.toFixed(2),
          gapPct: changePct.toFixed(2),
          absGap,
          source: "tv_watchlist",
        });
      }
    }
  } catch (err) {
    sourceErrors.push(`tv_watchlist: ${err.message}`);
  }

  // Source 2: Yahoo predefined screeners
  if (externalConfig.enabled !== false) {
    const screenIds = externalConfig.yahoo_screens || ["day_gainers", "day_losers", "most_actives"];
    const maxPerScreen = externalConfig.max_per_screen || 15;
    try {
      const yahooMovers = await fetchYahooScreeners(screenIds, maxPerScreen);
      yahooCount = yahooMovers.length;
      for (const m of yahooMovers) {
        if (coreWatchlist.includes(m.symbol)) continue;
        if (seen.has(m.symbol)) continue;
        if (m.absGap < threshold) continue;
        seen.add(m.symbol);
        allMovers.push(m);
      }
    } catch (err) {
      sourceErrors.push(`yahoo: ${err.message}`);
    }
  }

  if (!allMovers.length && sourceErrors.length === 2) {
    return { extras: [], screened: [], error: sourceErrors.join("; ") };
  }

  allMovers.sort((a, b) => b.absGap - a.absGap);

  return {
    totalChecked: tvCount + yahooCount,
    sources: { tv_watchlist: tvCount, yahoo: yahooCount },
    screened: allMovers,
    extras: allMovers.slice(0, maxExtras).map((m) => m.symbol),
    sourceErrors: sourceErrors.length ? sourceErrors : null,
  };
}

// =========================================================================
//  DEEP SCAN: Read ALL indicator data for a single symbol on current chart
// =========================================================================

/**
 * Reads study values, pine labels, pine lines, and pine boxes in parallel.
 * Must be called AFTER chart is already switched to the target symbol.
 * Waits for indicators to load (8s for heavy charts).
 */
async function scanSymbolDeep(symbol, waitMs = 3000) {
  // Wait for indicators to load after symbol switch
  await new Promise((r) => setTimeout(r, waitMs));

  // Verify chart actually switched by checking current symbol
  try {
    const state = await chart.getState();
    const currentSym = (state.symbol || "").replace(/.*:/, "");
    const targetSym = symbol.replace(/.*:/, "");
    if (currentSym && targetSym && currentSym.toUpperCase() !== targetSym.toUpperCase()) {
      // Chart didn't switch yet — wait more and retry
      process.stderr.write(`[scan] Chart shows ${currentSym}, expected ${targetSym} — waiting 3s more\n`);
      await chart.setSymbol({ symbol });
      await new Promise((r) => setTimeout(r, 3000));
    }
  } catch (_) {}

  const errors = [];

  // Read all data types in parallel
  const [studyResult, labelsResult, linesResult, boxesResult, quoteResult] =
    await Promise.allSettled([
      data.getStudyValues(),
      data.getPineLabels({ max_labels: 80, verbose: true }),
      data.getPineLines({}),
      data.getPineBoxes({}),
      data.getQuote({}),
    ]);

  const studies = studyResult.status === "fulfilled" ? studyResult.value : null;
  const labels = labelsResult.status === "fulfilled" ? labelsResult.value : null;
  const lines = linesResult.status === "fulfilled" ? linesResult.value : null;
  const boxes = boxesResult.status === "fulfilled" ? boxesResult.value : null;
  const quote = quoteResult.status === "fulfilled" ? quoteResult.value : null;

  if (studyResult.status === "rejected") errors.push(`studies: ${studyResult.reason?.message}`);
  if (labelsResult.status === "rejected") errors.push(`labels: ${labelsResult.reason?.message}`);
  if (linesResult.status === "rejected") errors.push(`lines: ${linesResult.reason?.message}`);
  if (boxesResult.status === "rejected") errors.push(`boxes: ${boxesResult.reason?.message}`);
  if (quoteResult.status === "rejected") errors.push(`quote: ${quoteResult.reason?.message}`);

  return { symbol, studies, labels, lines, boxes, quote, errors: errors.length ? errors : null };
}

// =========================================================================
//  SIGNAL EXTRACTION: Parse raw indicator data into chart signals
// =========================================================================

function findStudy(studies, pattern) {
  if (!studies?.studies) return null;
  return studies.studies.find((s) => pattern.test(s.name));
}

function findLabelStudy(labels, pattern) {
  if (!labels?.studies) return null;
  return labels.studies.find((s) => pattern.test(s.name));
}

function findLineStudy(lines, pattern) {
  if (!lines?.studies) return null;
  return lines.studies.find((s) => pattern.test(s.name));
}

function findBoxStudy(boxes, pattern) {
  if (!boxes?.studies) return null;
  return boxes.studies.find((s) => pattern.test(s.name));
}

/**
 * Extract all chart signals from raw scan data for one symbol.
 * Returns structured signal object used for scoring.
 */
function parseChartSignals(scan) {
  const price = scan.quote?.close || scan.quote?.last || 0;
  const signals = {
    breakout_channel: { found: false, direction: null, raw: null },
    structure_shift: { found: false, type: null, direction: null, labels: [], raw: null },
    liquidity_sweep: { found: false, type: null, labels: [], raw: null },
    order_blocks: { found: false, levels: [], zones: [], sources: [], raw: null },
    fvg: { found: false, exhaustion: null, zones: [], raw: null },
    bsl_ssl: { found: false, levels: [], raw: null },
    // Strong/Weak High/Low from SMC labels — tells us which liquidity is protected vs targetable
    liquidity_labels: { strong_lows: [], weak_lows: [], strong_highs: [], weak_highs: [], eqh: [], eql: [] },
  };

  const { studies, labels, lines, boxes } = scan;

  // 1. BREAKOUT CHANNEL (from study values)
  const bcStudy = findStudy(studies, INDICATOR_PATTERNS.breakoutChannel);
  if (bcStudy) {
    const vals = bcStudy.values || {};
    signals.breakout_channel.raw = vals;

    // AlgoAlpha breakout channel signals:
    // "Bullish Breakout Signal" / "Bearish Breakout Signal" as plot values
    const bullish = vals["Bullish Breakout Signal"];
    const bearish = vals["Bearish Breakout Signal"];
    // Also check for "Signal" or "Breakout" keys
    const signalVal = vals["Signal"] || vals["Breakout Signal"];

    // PlotCandle gives us the channel level regardless of which signal key is present
    const plotCandle = parseFloat(vals["PlotCandle"] || "0");
    const isNonZero = (v) => v && v !== "0" && v !== "∅" && v !== "0.00";

    if (isNonZero(bullish)) {
      signals.breakout_channel.found = true;
      signals.breakout_channel.direction = "bullish";
      if (plotCandle > 0) signals.breakout_channel.plotCandle = plotCandle;
    } else if (isNonZero(bearish)) {
      signals.breakout_channel.found = true;
      signals.breakout_channel.direction = "bearish";
      if (plotCandle > 0) signals.breakout_channel.plotCandle = plotCandle;
      // OVERRIDE: AlgoAlpha data window shows the LAST signal that fired.
      // If "Bearish Breakout Signal" persists but price is ABOVE both the
      // signal level AND the channel (PlotCandle), price has reclaimed —
      // the current structure is actually bullish.
      const bearishLvl = parseFloat(bearish);
      if (price > 0 && bearishLvl > 0 && plotCandle > 0) {
        if (price > bearishLvl && price > plotCandle) {
          signals.breakout_channel.direction = "bullish";
          signals.breakout_channel.override = `bearish signal at $${bearishLvl.toFixed(2)} but price $${price.toFixed(2)} reclaimed above channel`;
        }
      }
    } else {
      // No explicit signal — check PlotCandle for channel-active inference
      const upper = parseFloat(vals["Upper Channel"] || vals["Upper"] || "0");
      const lower = parseFloat(vals["Lower Channel"] || vals["Lower"] || "0");
      const mid = parseFloat(vals["Mid"] || vals["Middle"] || "0");

      if (plotCandle > 0) {
        signals.breakout_channel.found = true;
        signals.breakout_channel.plotCandle = plotCandle;
        // Direction inferred when price is significantly above/below the channel
        // (price will be checked in scoring against this value)
        signals.breakout_channel.direction = "channel_active";
        if (upper > 0) signals.breakout_channel.upper = upper;
        if (lower > 0) signals.breakout_channel.lower = lower;
        if (mid > 0) signals.breakout_channel.mid = mid;
      } else if (upper > 0 && lower > 0) {
        signals.breakout_channel.found = true;
        signals.breakout_channel.direction = "channel_active";
        signals.breakout_channel.upper = upper;
        signals.breakout_channel.lower = lower;
        signals.breakout_channel.mid = mid || (upper + lower) / 2;
      }
    }
  }

  // 2. STRUCTURE SHIFT — BOS/CHoCH from LuxAlgo SMC labels
  const smcLabels = findLabelStudy(labels, INDICATOR_PATTERNS.smcLuxalgo);
  if (smcLabels && smcLabels.labels) {
    const recentLabels = smcLabels.labels.slice(-20); // Last 20 labels
    let lastBosPrice = null;
    let lastChochPrice = null;
    // LuxAlgo SMC uses textColor to indicate direction:
    // 4282726130 (greenish) = bullish, 4286683400 (reddish) = bearish
    const BULLISH_COLOR = 4282726130;
    const BEARISH_COLOR = 4286683400;

    for (const lbl of recentLabels) {
      const text = (lbl.text || "").toUpperCase();
      if (/CHOCH|CHoCH/.test(text)) {
        signals.structure_shift.found = true;
        signals.structure_shift.type = "CHoCH";
        // 1st priority: explicit text direction
        let dir = /BULL|↑|UP/i.test(text) ? "bullish"
          : /BEAR|↓|DOWN/i.test(text) ? "bearish" : null;
        // 2nd priority: textColor from LuxAlgo (most reliable for labels without direction text)
        if (!dir && lbl.textColor) {
          if (lbl.textColor === BULLISH_COLOR) dir = "bullish";
          else if (lbl.textColor === BEARISH_COLOR) dir = "bearish";
        }
        // 3rd priority: price context relative to last BOS
        if (!dir && lbl.price > 0) {
          if (lastBosPrice && lbl.price > lastBosPrice) dir = "bullish";
          else if (lastBosPrice && lbl.price < lastBosPrice) dir = "bearish";
          else if (price > 0 && lbl.price > 0) {
            dir = price > lbl.price ? "bullish" : "bearish";
          }
        }
        signals.structure_shift.direction = dir || "detected";
        signals.structure_shift.labels.push({ text: lbl.text, price: lbl.price, dir });
        lastChochPrice = lbl.price;
      } else if (/BOS/.test(text)) {
        signals.structure_shift.found = true;
        signals.structure_shift.type = signals.structure_shift.type === "CHoCH" ? "CHoCH" : "BOS";
        let dir = /BULL|↑|UP/i.test(text) ? "bullish"
          : /BEAR|↓|DOWN/i.test(text) ? "bearish" : null;
        if (!dir && lbl.textColor) {
          if (lbl.textColor === BULLISH_COLOR) dir = "bullish";
          else if (lbl.textColor === BEARISH_COLOR) dir = "bearish";
        }
        if (!dir && lbl.price > 0) {
          if (lastBosPrice && lbl.price > lastBosPrice) dir = "bullish";
          else if (lastBosPrice && lbl.price < lastBosPrice) dir = "bearish";
          else if (price > 0) dir = price > lbl.price ? "bullish" : "bearish";
        }
        signals.structure_shift.direction = dir || "detected";
        signals.structure_shift.labels.push({ text: lbl.text, price: lbl.price, dir });
        lastBosPrice = lbl.price;
      }
    }
    signals.structure_shift.raw = recentLabels.slice(-5);
  }

  // Also check for SMC in study values (PlotCandle values)
  const smcStudy = findStudy(studies, INDICATOR_PATTERNS.smcLuxalgo);
  if (smcStudy && !signals.structure_shift.found) {
    signals.structure_shift.raw = smcStudy.values;
  }

  // 2b. STRONG/WEAK HIGH/LOW + EQH/EQL labels from SMC
  //     These tell us which liquidity levels are protected (Strong) vs targetable (Weak)
  //     Weak Low = market expects it to get swept (bearish magnet)
  //     Strong Low = market says it holds (bullish floor)
  //     Weak High = market expects it to get taken out (bullish magnet)
  //     Strong High = market says it holds (bearish ceiling)
  if (smcLabels && smcLabels.labels) {
    for (const lbl of smcLabels.labels) {
      const text = (lbl.text || "").toLowerCase();
      const p = lbl.price;
      if (!p || p <= 0) continue;
      if (/strong\s*low|strong_low/i.test(text)) signals.liquidity_labels.strong_lows.push(p);
      else if (/weak\s*low|weak_low/i.test(text)) signals.liquidity_labels.weak_lows.push(p);
      else if (/strong\s*high|strong_high/i.test(text)) signals.liquidity_labels.strong_highs.push(p);
      else if (/weak\s*high|weak_high/i.test(text)) signals.liquidity_labels.weak_highs.push(p);
      else if (/^eqh$/i.test(text.trim())) signals.liquidity_labels.eqh.push(p);
      else if (/^eql$/i.test(text.trim())) signals.liquidity_labels.eql.push(p);
    }
  }

  // 3. LIQUIDITY SWEEP from labels
  const sweepLabels = findLabelStudy(labels, INDICATOR_PATTERNS.liquiditySweep);
  if (sweepLabels && sweepLabels.labels) {
    const recentSweeps = sweepLabels.labels.slice(-10);
    for (const lbl of recentSweeps) {
      const text = (lbl.text || "").toUpperCase();
      if (/SWEEP|LIQ|BSL|SSL/i.test(text)) {
        signals.liquidity_sweep.found = true;
        signals.liquidity_sweep.type = /BSL|BUY.?SIDE|HIGH/i.test(text) ? "BSL_sweep"
          : /SSL|SELL.?SIDE|LOW/i.test(text) ? "SSL_sweep" : "sweep";
        signals.liquidity_sweep.labels.push({ text: lbl.text, price: lbl.price });
      }
    }
    signals.liquidity_sweep.raw = recentSweeps.slice(-3);
  }

  // Also check sweep study values
  const sweepStudy = findStudy(studies, INDICATOR_PATTERNS.liquiditySweep);
  if (sweepStudy) {
    const vals = sweepStudy.values || {};
    if (!signals.liquidity_sweep.found) {
      // Check for non-zero sweep signals in values
      for (const [key, val] of Object.entries(vals)) {
        if (/sweep/i.test(key) && val && val !== "0" && val !== "∅" && val !== "0.00") {
          signals.liquidity_sweep.found = true;
          signals.liquidity_sweep.type = /bsl|buy/i.test(key) ? "BSL_sweep" : /ssl|sell/i.test(key) ? "SSL_sweep" : "sweep";
        }
      }
    }
    signals.liquidity_sweep.raw = signals.liquidity_sweep.raw || vals;
  }

  // 4. ORDER BLOCKS — from lines and boxes (Sonarlab + LuxAlgo)
  //    Now classifies zones as ABOVE vs BELOW price for target/support analysis
  for (const pattern of [INDICATOR_PATTERNS.orderBlockSonarlab, INDICATOR_PATTERNS.orderBlockLuxalgo]) {
    const obLines = findLineStudy(lines, pattern);
    if (obLines && obLines.horizontal_levels?.length > 0) {
      signals.order_blocks.found = true;
      signals.order_blocks.levels.push(...obLines.horizontal_levels.slice(0, 10));
      signals.order_blocks.sources.push(obLines.name);
    }
    const obBoxes = findBoxStudy(boxes, pattern);
    if (obBoxes && obBoxes.zones?.length > 0) {
      signals.order_blocks.found = true;
      for (const z of obBoxes.zones.slice(0, 10)) {
        signals.order_blocks.levels.push(z.high, z.low);
        // Store full zones for resistance/support classification
        if (!signals.order_blocks.zones) signals.order_blocks.zones = [];
        signals.order_blocks.zones.push(z);
      }
      signals.order_blocks.sources.push(obBoxes.name);
    }
  }
  // Deduplicate and sort OB levels
  if (signals.order_blocks.levels.length) {
    signals.order_blocks.levels = [...new Set(signals.order_blocks.levels)].sort((a, b) => b - a);
  }

  // 5. FVG — from boxes (BigBeluga, Expo) and study values (IFVG Expo)
  for (const pattern of [INDICATOR_PATTERNS.fvgBigBeluga, INDICATOR_PATTERNS.fvgExpo]) {
    const fvgBoxes = findBoxStudy(boxes, pattern);
    if (fvgBoxes && fvgBoxes.zones?.length > 0) {
      signals.fvg.found = true;
      signals.fvg.zones.push(...fvgBoxes.zones.slice(0, 10));
    }
  }
  // IFVG Expo LINE levels — these are key horizontal levels (e.g. $426.27, $418.32)
  // that mark institutional FVG boundaries. Critical for target identification.
  if (!signals.fvg.key_levels) signals.fvg.key_levels = [];
  for (const pattern of [INDICATOR_PATTERNS.fvgExpo, INDICATOR_PATTERNS.fvgBigBeluga]) {
    const fvgLines = findLineStudy(lines, pattern);
    if (fvgLines && fvgLines.horizontal_levels?.length > 0) {
      signals.fvg.found = true;
      signals.fvg.key_levels.push(...fvgLines.horizontal_levels.slice(0, 10));
    }
  }
  // IFVG Expo study values — exhaustion signals
  const ifvgStudy = findStudy(studies, INDICATOR_PATTERNS.fvgExpo);
  if (ifvgStudy) {
    const vals = ifvgStudy.values || {};
    const newHigh = parseFloat(vals["New High above Liquidity Range"] || "0");
    const newLow = parseFloat(vals["New Low below Liquidity Range"] || "0");
    if (newHigh > 0) {
      signals.fvg.found = true;
      signals.fvg.exhaustion = "bullish_exhaustion";
      signals.fvg.exhaustion_value = newHigh;
    } else if (newLow > 0) {
      signals.fvg.found = true;
      signals.fvg.exhaustion = "bearish_exhaustion";
      signals.fvg.exhaustion_value = newLow;
    }
    signals.fvg.raw = vals;
  }

  // 6. BSL/SSL levels from lines
  const bslSslStudy = findLineStudy(lines, INDICATOR_PATTERNS.bslSsl);
  if (bslSslStudy && bslSslStudy.horizontal_levels?.length > 0) {
    signals.bsl_ssl.found = true;
    signals.bsl_ssl.levels = bslSslStudy.horizontal_levels.slice(0, 10);
  }
  // Also check labels for BSL/SSL markers
  const bslSslLabels = findLabelStudy(labels, INDICATOR_PATTERNS.bslSsl);
  if (bslSslLabels && bslSslLabels.labels?.length > 0) {
    signals.bsl_ssl.found = true;
    for (const lbl of bslSslLabels.labels.slice(-5)) {
      if (lbl.price) signals.bsl_ssl.levels.push(lbl.price);
      signals.bsl_ssl.labels = signals.bsl_ssl.labels || [];
      signals.bsl_ssl.labels.push({ text: lbl.text, price: lbl.price });
    }
  }

  return signals;
}

// =========================================================================
//  REGIME GATE: Read SPY + QQQ breakout channels
// =========================================================================

/**
 * Determine market regime from SPY and QQQ breakout channels.
 * Must switch chart to SPY/QQQ, read, then restore.
 */
async function readRegime(currentSymbol) {
  const regimeData = {};

  for (const idx of ["SPY", "QQQ"]) {
    try {
      await chart.setSymbol({ symbol: idx });
      await new Promise((r) => setTimeout(r, 2500)); // Wait for indicators

      const studyResult = await data.getStudyValues();
      const bcStudy = findStudy(studyResult, INDICATOR_PATTERNS.breakoutChannel);

      regimeData[idx] = {
        breakout_channel: bcStudy?.values || null,
        direction: null,
      };

      if (bcStudy) {
        const vals = bcStudy.values || {};
        const bullish = vals["Bullish Breakout Signal"];
        const bearish = vals["Bearish Breakout Signal"];
        const plotCandle = parseFloat(vals["PlotCandle"] || "0");
        const isNonZero = (v) => v && v !== "0" && v !== "∅" && v !== "0.00";

        // Get current price for this index
        let idxPrice = 0;
        try {
          const q = await data.getQuote({ symbol: idx });
          idxPrice = q?.close || q?.last || 0;
        } catch (_) {}

        if (isNonZero(bullish)) {
          regimeData[idx].direction = "bullish";
        } else if (isNonZero(bearish)) {
          regimeData[idx].direction = "bearish";
          // OVERRIDE: If bearish signal persists but price reclaimed above
          // both the signal level and the channel, structure is actually bullish
          const bearishLvl = parseFloat(bearish);
          if (idxPrice > 0 && bearishLvl > 0 && plotCandle > 0) {
            if (idxPrice > bearishLvl && idxPrice > plotCandle) {
              regimeData[idx].direction = "bullish";
              regimeData[idx].override = `bearish signal at $${bearishLvl.toFixed(2)} but ${idx} $${idxPrice.toFixed(2)} reclaimed above channel`;
            }
          }
        } else if (plotCandle > 0 && idxPrice > 0) {
          // No explicit signal — infer from price vs channel
          const pctAbove = (idxPrice - plotCandle) / plotCandle * 100;
          const threshold = idxPrice > 500 ? 0.1 : 0.15;
          if (pctAbove > threshold) regimeData[idx].direction = "bullish";
          else if (pctAbove < -threshold) regimeData[idx].direction = "bearish";
          else regimeData[idx].direction = "neutral";
        } else {
          regimeData[idx].direction = "neutral";
        }
      }
    } catch (err) {
      regimeData[idx] = { error: err.message, direction: "unknown" };
    }
  }

  // Determine overall regime
  const spyDir = regimeData.SPY?.direction;
  const qqqDir = regimeData.QQQ?.direction;

  let regime = "neutral";
  if (spyDir === "bullish" && qqqDir === "bullish") regime = "bullish";
  else if (spyDir === "bearish" && qqqDir === "bearish") regime = "bearish";
  else if (spyDir === "bullish" || qqqDir === "bullish") regime = "lean_bullish";
  else if (spyDir === "bearish" || qqqDir === "bearish") regime = "lean_bearish";

  return { regime, spy: regimeData.SPY, qqq: regimeData.QQQ };
}

// =========================================================================
//  SCORING ENGINE: Chart-first, options-second
// =========================================================================

/**
 * Score a setup using chart-first rules from rules.json.
 * Returns { score, conviction, direction, signals_hit, anti_patterns, qualified }
 */
function scoreSetup(signals, regime, quote) {
  const hit = [];
  const missed = [];
  let direction = null;

  // Count chart signals
  // 1. Breakout channel direction
  const price = quote?.close || quote?.last || 0;
  if (signals.breakout_channel.found) {
    let bcDirection = signals.breakout_channel.direction;
    let bcDetail = bcDirection;

    // If direction is "channel_active" with PlotCandle, infer from price position
    // Use tight threshold — 0.15% is significant for SPY/QQQ, 0.3% for most stocks
    if (bcDirection === "channel_active" && signals.breakout_channel.plotCandle && price > 0) {
      const pc = signals.breakout_channel.plotCandle;
      const pctAbove = (price - pc) / pc * 100;
      // Adaptive threshold: tighter for expensive/low-vol names (ETFs, mega-caps)
      const threshold = price > 500 ? 0.1 : price > 200 ? 0.15 : price > 50 ? 0.3 : 0.5;
      if (pctAbove > threshold) {
        bcDirection = "bullish";
        bcDetail = `bullish (price ${pctAbove.toFixed(2)}% above channel @ $${pc.toFixed(2)})`;
      } else if (pctAbove < -threshold) {
        bcDirection = "bearish";
        bcDetail = `bearish (price ${Math.abs(pctAbove).toFixed(2)}% below channel @ $${pc.toFixed(2)})`;
      } else {
        bcDetail = `channel_active (price near channel @ $${pc.toFixed(2)})`;
      }
    }

    hit.push({
      signal: "breakout_channel",
      detail: bcDetail,
      indicator: "Smart Money Breakout Channels [AlgoAlpha]",
    });
    if (bcDirection === "bullish") direction = "CALLS";
    else if (bcDirection === "bearish") direction = "PUTS";
  } else {
    missed.push("breakout_channel");
  }

  // 2. Structure shift (CHoCH / BOS)
  if (signals.structure_shift.found) {
    hit.push({
      signal: "structure_shift",
      detail: `${signals.structure_shift.type} ${signals.structure_shift.direction}`,
      indicator: "Smart Money Concepts [LuxAlgo]",
      labels: signals.structure_shift.labels.slice(-3),
    });
    // CHoCH can override breakout channel direction ONLY if liquidity sweep confirms it.
    // Rule: "NEVER fight the Smart Money Breakout Channel direction without sweep + CHoCH"
    // Without a sweep, CHoCH alone is NOT enough to flip direction against the channel.
    const chochDir = signals.structure_shift.direction === "bullish" ? "CALLS"
      : signals.structure_shift.direction === "bearish" ? "PUTS" : null;
    const channelDir = direction; // Already set from breakout channel above
    const hasSweep = signals.liquidity_sweep.found;

    if (chochDir && channelDir && chochDir !== channelDir) {
      // CHoCH disagrees with channel — only override if sweep confirms
      process.stderr.write(`[edge] CHANNEL CONFLICT: channel=${channelDir} choch=${chochDir} sweep=${hasSweep}\n`);
      if (hasSweep) {
        direction = chochDir;
        signals.structure_shift.channel_override = true;
      }
      // Without sweep: keep channel direction, flag the disagreement
      signals.structure_shift.channel_conflict = true;
    } else if (chochDir && !channelDir) {
      // No channel signal — CHoCH sets direction freely
      direction = chochDir;
    } else if (chochDir && chochDir === channelDir) {
      // CHoCH agrees with channel — strongest confirmation
      direction = chochDir;
      signals.structure_shift.channel_agrees = true;
    }
  } else {
    missed.push("structure_shift");
  }

  // 3. Liquidity sweep
  if (signals.liquidity_sweep.found) {
    hit.push({
      signal: "liquidity_sweep",
      detail: signals.liquidity_sweep.type,
      indicator: "Liquidity Sweeps [LuxAlgo]",
      labels: signals.liquidity_sweep.labels.slice(-2),
    });
  } else {
    missed.push("liquidity_sweep");
  }

  // 4. Order blocks
  if (signals.order_blocks.found) {
    // Check if price is near an OB level
    const nearOB = signals.order_blocks.levels.some(
      (lvl) => price > 0 && Math.abs((price - lvl) / price) < 0.005
    );
    hit.push({
      signal: "order_block",
      detail: `${signals.order_blocks.levels.length} levels from ${signals.order_blocks.sources.join(", ")}`,
      near_price: nearOB,
      top_levels: signals.order_blocks.levels.slice(0, 5),
      indicator: signals.order_blocks.sources.join(" + "),
    });
  } else {
    missed.push("order_block");
  }

  // 5. FVG
  if (signals.fvg.found) {
    hit.push({
      signal: "fvg",
      detail: signals.fvg.exhaustion || `${signals.fvg.zones.length} zones`,
      indicator: "IFVG Expo + BigBeluga FVG",
    });
  } else {
    missed.push("fvg");
  }

  // 6. BSL/SSL levels
  if (signals.bsl_ssl.found) {
    hit.push({
      signal: "bsl_ssl",
      detail: `${signals.bsl_ssl.levels.length} levels`,
      top_levels: signals.bsl_ssl.levels.slice(0, 5),
      indicator: "Buyside & Sellside Liquidity [LuxAlgo]",
    });
  } else {
    missed.push("bsl_ssl");
  }

  const score = hit.length;

  // --- ANTI-PATTERN CHECKS ---
  const antiPatterns = [];

  // Check regime agreement
  const regimeBullish = regime === "bullish" || regime === "lean_bullish";
  const regimeBearish = regime === "bearish" || regime === "lean_bearish";

  // Anti-pattern: Fading regime without sweep + CHoCH
  if (direction === "PUTS" && regimeBullish) {
    if (!signals.liquidity_sweep.found || signals.structure_shift.type !== "CHoCH") {
      antiPatterns.push("BLOCKED: Puts in bullish regime without confirmed sweep + CHoCH reversal");
      direction = null; // Block the trade
    }
  }
  if (direction === "CALLS" && regimeBearish) {
    if (!signals.liquidity_sweep.found || signals.structure_shift.type !== "CHoCH") {
      antiPatterns.push("BLOCKED: Calls in bearish regime without confirmed sweep + CHoCH reversal");
      direction = null;
    }
  }

  // Anti-pattern: No sweep = no fade
  if (signals.fvg.exhaustion && !signals.liquidity_sweep.found) {
    antiPatterns.push("WARNING: Exhaustion signal without liquidity sweep — not a valid fade");
  }

  // Anti-pattern: CHoCH fought the channel without a sweep
  if (signals.structure_shift.channel_conflict) {
    antiPatterns.push(
      `BLOCKED: CHoCH ${signals.structure_shift.direction} fights ${signals.breakout_channel.direction} breakout channel — no sweep to confirm reversal. Direction stays with channel.`
    );
  }
  if (signals.structure_shift.channel_override) {
    antiPatterns.push(
      `OVERRIDE: CHoCH + sweep confirmed reversal against ${signals.breakout_channel.direction} channel — valid fade`
    );
  }
  if (signals.structure_shift.channel_agrees) {
    antiPatterns.push(
      `CONFIRMED: CHoCH ${signals.structure_shift.direction} agrees with ${signals.breakout_channel.direction} channel — highest conviction`
    );
  }

  // Anti-pattern: Strong/Weak label conflicts with trade direction
  const liq = signals.liquidity_labels || {};
  const nearestWeakHigh = (liq.weak_highs || []).filter(p => p > price).sort((a, b) => a - b)[0];
  const nearestWeakLow = (liq.weak_lows || []).filter(p => p < price).sort((a, b) => b - a)[0];
  const nearestStrongLow = (liq.strong_lows || []).filter(p => p < price).sort((a, b) => b - a)[0];
  const nearestStrongHigh = (liq.strong_highs || []).filter(p => p > price).sort((a, b) => a - b)[0];

  // PUTS blocked: if nearest low is Strong (protected), puts target is invalid
  if (direction === "PUTS" && nearestStrongLow && !nearestWeakLow) {
    antiPatterns.push(`BLOCKED: Puts target Strong Low at $${nearestStrongLow.toFixed(2)} — market says it holds, no downside target`);
    direction = null;
  }
  // PUTS warning: if nearest low is Strong but there IS a weak low further down
  if (direction === "PUTS" && nearestStrongLow && nearestWeakLow && nearestStrongLow > nearestWeakLow) {
    antiPatterns.push(`WARNING: Strong Low at $${nearestStrongLow.toFixed(2)} protects before Weak Low at $${nearestWeakLow.toFixed(2)} — reduced conviction`);
    if (conviction > 3) conviction = 3;
  }

  // CALLS blocked: if nearest high is Strong (protected ceiling), calls target is capped
  if (direction === "CALLS" && nearestStrongHigh && !nearestWeakHigh) {
    antiPatterns.push(`BLOCKED: Calls face Strong High at $${nearestStrongHigh.toFixed(2)} — market says it holds, no upside target`);
    direction = null;
  }
  // CALLS boosted: if Weak High is above = bullish magnet, confirms calls
  if (direction === "CALLS" && nearestWeakHigh) {
    antiPatterns.push(`CONFIRMED: Weak High at $${nearestWeakHigh.toFixed(2)} — market expects it to get taken out, bullish target`);
  }
  // PUTS boosted: if Weak Low is below = bearish magnet, confirms puts
  if (direction === "PUTS" && nearestWeakLow) {
    antiPatterns.push(`CONFIRMED: Weak Low at $${nearestWeakLow.toFixed(2)} — market expects it to get swept, bearish target`);
  }

  // Determine if required signals are met
  const hasRequiredSignal = signals.structure_shift.found || signals.liquidity_sweep.found;

  // Conviction scale
  let conviction = 0;
  if (score >= 4 && hasRequiredSignal) conviction = 5;
  else if (score >= 3 && hasRequiredSignal) conviction = 4;
  else if (score >= 3) conviction = 3;
  else conviction = score;

  // If anti-patterns blocked the trade, zero out
  if (antiPatterns.some((ap) => ap.startsWith("BLOCKED"))) {
    conviction = 0;
    direction = null;
  }

  // If no direction from breakout channel, infer from structure shift or regime
  if (!direction && !antiPatterns.some((ap) => ap.startsWith("BLOCKED"))) {
    // Try structure shift direction first
    if (signals.structure_shift.found) {
      if (signals.structure_shift.direction === "bullish") direction = "CALLS";
      else if (signals.structure_shift.direction === "bearish") direction = "PUTS";
    }
    // Fall back to regime direction
    if (!direction) {
      if (regimeBullish) direction = "CALLS";
      else if (regimeBearish) direction = "PUTS";
    }
  }

  const qualified = score >= 3 && hasRequiredSignal && conviction >= 3 && direction !== null;

  return {
    score,
    conviction,
    direction,
    qualified,
    signals_hit: hit,
    signals_missed: missed,
    anti_patterns: antiPatterns.length ? antiPatterns : null,
    has_required_signal: hasRequiredSignal,
  };
}

// =========================================================================
//  TIME-BASED RULES
// =========================================================================

function checkTimeRules() {
  const now = new Date();
  const hour = now.getHours();
  const min = now.getMinutes();
  const timeMinutes = hour * 60 + min;

  const warnings = [];

  // No entries 9:30-9:45
  if (timeMinutes >= 570 && timeMinutes < 585) {
    warnings.push("⚠️ FIRST 15 MIN: No entries 9:30-9:45 AM — wait for opening volatility to settle");
  }

  // No entries 11:30-1:00 (lunch chop)
  if (timeMinutes >= 690 && timeMinutes < 780) {
    warnings.push("⚠️ LUNCH CHOP: 11:30 AM - 1:00 PM — avoid new entries, setups are unreliable");
  }

  // After 3:00 PM — size down
  if (timeMinutes >= 900) {
    warnings.push("⚠️ LATE SESSION: After 3:00 PM — reduced time value, tighten stops");
  }

  // After 3:50 PM — no new entries for 0DTE
  if (timeMinutes >= 950) {
    warnings.push("🛑 NO 0DTE: After 3:50 PM — do not open new 0DTE positions");
  }

  return {
    current_time: now.toLocaleTimeString("en-US", { hour12: true, timeZone: "America/New_York" }),
    market_open: timeMinutes >= 570 && timeMinutes < 960,
    warnings: warnings.length ? warnings : null,
  };
}

// =========================================================================
//  MAIN EDGE FUNCTION
// =========================================================================

/**
 * The primary trading tool. Chart-first scoring across watchlist.
 *
 * Flow:
 *   1. Read regime (SPY + QQQ breakout channels)
 *   2. For each symbol: deep scan → parse signals → score
 *   3. Filter to qualified setups (3+ chart signals)
 *   4. Optionally run options analysis on qualified names
 *   5. Return play cards
 */
export async function runEdge({ rules_path, symbols, skip_regime, skip_options, bankroll } = {}) {
  const { rules, path: loadedFrom } = loadRules(rules_path);
  const {
    watchlist = [],
    default_timeframe = "5",
    edge_scoring = {},
    risk_rules = [],
    options_analysis: optConfig = {},
  } = rules;

  const scanList = symbols || watchlist;
  const bank = bankroll || 25000;
  const timeRules = checkTimeRules();

  if (!scanList.length) {
    throw new Error("No symbols to scan. Pass symbols array or set watchlist in rules.json.");
  }

  // Save current chart state
  let originalSymbol, originalTimeframe;
  try {
    const currentState = await chart.getState();
    originalSymbol = currentState.symbol;
    originalTimeframe = currentState.resolution;
  } catch (_) {}

  // Set timeframe
  try {
    await chart.setTimeframe({ timeframe: default_timeframe });
    await new Promise((r) => setTimeout(r, 400));
  } catch (_) {}

  // --- STEP 1: REGIME GATE ---
  let regimeResult = null;
  if (!skip_regime) {
    try {
      regimeResult = readRegime(originalSymbol);
      // We need to await it
      regimeResult = await regimeResult;
    } catch (err) {
      regimeResult = { regime: "unknown", error: err.message };
    }
  } else {
    regimeResult = { regime: "neutral", skipped: true };
  }

  // --- STEP 2: SCAN EACH SYMBOL on primary timeframe (5m) ---
  const scans = [];
  const scoredSetups = [];

  for (const symbol of scanList) {
    try {
      // Switch chart
      await chart.setSymbol({ symbol });

      // Deep scan (reads all indicator data types)
      const scan = await scanSymbolDeep(symbol, scanList.length > 3 ? 2000 : 3000);

      // Parse chart signals
      const signals = parseChartSignals(scan);

      // Score the setup
      const scoring = scoreSetup(signals, regimeResult.regime, scan.quote);

      const result = {
        symbol,
        quote: scan.quote ? {
          last: scan.quote.close || scan.quote.last,
          change: scan.quote.change,
          changePct: scan.quote.change_percent,
          volume: scan.quote.volume,
        } : null,
        signals,
        scoring,
        scan_errors: scan.errors,
      };

      scans.push(result);

      if (scoring.qualified) {
        scoredSetups.push(result);
      }
    } catch (err) {
      scans.push({ symbol, error: err.message });
    }
  }

  // --- STEP 2a: 1m QUICK SCAN for Strong/Weak Low/High labels on qualified setups ---
  // The 5m chart doesn't show Strong/Weak labels — only the 1m does.
  // This scan reads ONLY pine labels on 1m, then merges into the 5m signals.
  if (scoredSetups.length > 0) {
    try {
      await chart.setTimeframe({ timeframe: "1" });
      await new Promise((r) => setTimeout(r, 400));

      for (const setup of scoredSetups) {
        try {
          await chart.setSymbol({ symbol: setup.symbol });
          await new Promise((r) => setTimeout(r, 1500));

          // Only read labels on 1m — we just need Strong/Weak/EQH/EQL
          const labels1m = await data.getPineLabels({ max_labels: 80, verbose: true });
          const smcLabels1m = findLabelStudy(labels1m, INDICATOR_PATTERNS.smcLuxalgo);

          if (smcLabels1m && smcLabels1m.labels) {
            if (!setup.signals.liquidity_labels) {
              setup.signals.liquidity_labels = { strong_lows: [], weak_lows: [], strong_highs: [], weak_highs: [], eqh: [], eql: [] };
            }
            for (const lbl of smcLabels1m.labels) {
              const text = (lbl.text || "").toLowerCase().trim();
              const p = lbl.price;
              if (!p || p <= 0) continue;
              if (/strong\s*low|strong_low/i.test(text)) setup.signals.liquidity_labels.strong_lows.push(p);
              else if (/weak\s*low|weak_low/i.test(text)) setup.signals.liquidity_labels.weak_lows.push(p);
              else if (/strong\s*high|strong_high/i.test(text)) setup.signals.liquidity_labels.strong_highs.push(p);
              else if (/weak\s*high|weak_high/i.test(text)) setup.signals.liquidity_labels.weak_highs.push(p);
              else if (/^eqh$/i.test(text)) setup.signals.liquidity_labels.eqh.push(p);
              else if (/^eql$/i.test(text)) setup.signals.liquidity_labels.eql.push(p);
            }

            // Also read 1m structure shift to check if 1m agrees with trade direction
            const BULLISH_COLOR_1m = 4282726130;
            const BEARISH_COLOR_1m = 4286683400;
            let last1mChoch = null;
            for (const lbl of smcLabels1m.labels) {
              const text = (lbl.text || "").toUpperCase();
              if (/CHOCH|CHoCH/.test(text)) {
                let dir = null;
                if (lbl.textColor === BULLISH_COLOR_1m) dir = "bullish";
                else if (lbl.textColor === BEARISH_COLOR_1m) dir = "bearish";
                if (dir) last1mChoch = dir;
              }
            }

            if (last1mChoch) {
              setup.tf_1m_structure = last1mChoch;
              const tradeDir = setup.scoring.direction;
              const agrees1m = (tradeDir === "CALLS" && last1mChoch === "bullish") ||
                               (tradeDir === "PUTS" && last1mChoch === "bearish");
              if (!agrees1m) {
                if (!setup.scoring.anti_patterns) setup.scoring.anti_patterns = [];
                setup.scoring.anti_patterns.push(
                  `WARNING: 1m structure is ${last1mChoch} but trade is ${tradeDir} — lowest timeframe disagrees`
                );
              }
            }

            // Re-run Strong/Weak anti-pattern checks now that we have 1m labels
            const price = setup.quote?.last || 0;
            const liq = setup.signals.liquidity_labels;
            const nearestStrongLow = (liq.strong_lows || []).filter(p => p < price).sort((a, b) => b - a)[0];
            const nearestWeakLow = (liq.weak_lows || []).filter(p => p < price).sort((a, b) => b - a)[0];
            const nearestStrongHigh = (liq.strong_highs || []).filter(p => p > price).sort((a, b) => a - b)[0];
            const nearestWeakHigh = (liq.weak_highs || []).filter(p => p > price).sort((a, b) => a - b)[0];

            if (!setup.scoring.anti_patterns) setup.scoring.anti_patterns = [];

            if (setup.scoring.direction === "PUTS" && nearestStrongLow && !nearestWeakLow) {
              setup.scoring.anti_patterns.push(
                `BLOCKED: 1m Strong Low at $${nearestStrongLow.toFixed(2)} — no Weak Low below, puts have no target`
              );
              setup.scoring.direction = null;
              setup.scoring.conviction = 0;
              setup.scoring.qualified = false;
            } else if (setup.scoring.direction === "PUTS" && nearestWeakLow) {
              setup.scoring.anti_patterns.push(
                `CONFIRMED: 1m Weak Low at $${nearestWeakLow.toFixed(2)} — bearish target, market expects sweep`
              );
            }

            if (setup.scoring.direction === "CALLS" && nearestStrongHigh && !nearestWeakHigh) {
              setup.scoring.anti_patterns.push(
                `BLOCKED: 1m Strong High at $${nearestStrongHigh.toFixed(2)} — no Weak High above, calls have no target`
              );
              setup.scoring.direction = null;
              setup.scoring.conviction = 0;
              setup.scoring.qualified = false;
            } else if (setup.scoring.direction === "CALLS" && nearestWeakHigh) {
              setup.scoring.anti_patterns.push(
                `CONFIRMED: 1m Weak High at $${nearestWeakHigh.toFixed(2)} — bullish target, market expects takeout`
              );
            }

            // Clean up empty anti_patterns
            if (setup.scoring.anti_patterns.length === 0) setup.scoring.anti_patterns = null;
          }
        } catch (err) {
          // 1m scan failed for this symbol — continue without it
          process.stderr.write(`[edge] 1m scan failed for ${setup.symbol}: ${err.message}\n`);
        }
      }

      // Switch back to primary timeframe
      try {
        await chart.setTimeframe({ timeframe: default_timeframe });
        await new Promise((r) => setTimeout(r, 300));
      } catch (_) {}
    } catch (err) {
      process.stderr.write(`[edge] 1m scan pass failed: ${err.message}\n`);
    }
  }

  // --- STEP 2b: HTF PASS — read 15m for bigger targets/walls on qualified setups ---
  const htfTimeframe = rules.confirmation_timeframe || rules.trader_profile?.confirmation_timeframe || "15";
  if (scoredSetups.length > 0) {
    try {
      await chart.setTimeframe({ timeframe: htfTimeframe });
      await new Promise((r) => setTimeout(r, 500));

      for (const setup of scoredSetups) {
        try {
          await chart.setSymbol({ symbol: setup.symbol });
          // Read lines + boxes on HTF (bigger OB zones, BSL/SSL)
          const htfScan = await scanSymbolDeep(setup.symbol, 2000);
          const htfSignals = parseChartSignals(htfScan);

          // Merge HTF levels INTO the 5m signals — don't replace, ADD
          // HTF OB zones are the bigger walls/support that 5m misses
          if (htfSignals.order_blocks.found) {
            if (!setup.signals.order_blocks.htf_zones) setup.signals.order_blocks.htf_zones = [];
            setup.signals.order_blocks.htf_zones.push(...(htfSignals.order_blocks.zones || []));
            // Add HTF OB levels to the main levels array (deduped later in analyzeLevels)
            const htfOBLevels = htfSignals.order_blocks.levels || [];
            for (const lvl of htfOBLevels) {
              if (!setup.signals.order_blocks.levels.includes(lvl)) {
                setup.signals.order_blocks.levels.push(lvl);
              }
            }
            setup.signals.order_blocks.levels.sort((a, b) => b - a);
          }

          // HTF BSL/SSL levels — bigger liquidity pools
          if (htfSignals.bsl_ssl.found) {
            if (!setup.signals.bsl_ssl.htf_levels) setup.signals.bsl_ssl.htf_levels = [];
            for (const lvl of (htfSignals.bsl_ssl.levels || [])) {
              if (!setup.signals.bsl_ssl.levels.includes(lvl)) {
                setup.signals.bsl_ssl.levels.push(lvl);
                setup.signals.bsl_ssl.htf_levels.push(lvl);
              }
            }
          }

          // HTF FVG zones — bigger gaps
          if (htfSignals.fvg.found) {
            if (!setup.signals.fvg.htf_zones) setup.signals.fvg.htf_zones = [];
            setup.signals.fvg.htf_zones.push(...(htfSignals.fvg.zones || []));
            setup.signals.fvg.zones.push(...(htfSignals.fvg.zones || []));
          }

          // HTF IFVG key levels (horizontal lines from IFVG Expo)
          if (htfSignals.fvg.key_levels?.length > 0) {
            if (!setup.signals.fvg.key_levels) setup.signals.fvg.key_levels = [];
            for (const lvl of htfSignals.fvg.key_levels) {
              if (!setup.signals.fvg.key_levels.includes(lvl)) {
                setup.signals.fvg.key_levels.push(lvl);
              }
            }
          }

          // HTF STRUCTURE AGREEMENT CHECK — if 15m structure disagrees with 5m direction, downgrade
          const htfStructure = htfSignals.structure_shift;
          if (htfStructure.found && setup.direction) {
            const htfDir = htfStructure.direction; // "bullish" or "bearish"
            const tradeDir = setup.direction; // "CALLS" or "PUTS"
            const agrees = (tradeDir === "CALLS" && htfDir === "bullish") ||
                           (tradeDir === "PUTS" && htfDir === "bearish");
            setup.htf_structure = {
              direction: htfDir,
              type: htfStructure.type,
              agrees,
            };
            if (!agrees) {
              // HTF disagrees — downgrade conviction, flag anti-pattern
              if (!setup.anti_patterns) setup.anti_patterns = [];
              setup.anti_patterns.push(
                `WARNING: ${htfTimeframe}m structure is ${htfDir} (${htfStructure.type}) but trade is ${tradeDir} — HTF disagrees, conviction reduced`
              );
              if (setup.conviction > 3) setup.conviction = 3;
              setup.htf_disagreement = true;
            } else {
              // HTF agrees — boost conviction note
              if (!setup.anti_patterns) setup.anti_patterns = [];
              setup.anti_patterns.push(
                `CONFIRMED: ${htfTimeframe}m structure ${htfDir} (${htfStructure.type}) agrees with ${tradeDir}`
              );
            }
          }

          // HTF Strong/Weak labels — merge into main signals for anti-pattern checks
          const htfLiq = htfSignals.liquidity_labels || {};
          for (const key of ["strong_lows", "weak_lows", "strong_highs", "weak_highs"]) {
            if (htfLiq[key]?.length) {
              if (!setup.signals.liquidity_labels) setup.signals.liquidity_labels = { strong_lows: [], weak_lows: [], strong_highs: [], weak_highs: [], eqh: [], eql: [] };
              setup.signals.liquidity_labels[key].push(...htfLiq[key]);
            }
          }

          // Tag that we have HTF data
          setup.htf_timeframe = htfTimeframe;
          setup.htf_scan = true;
        } catch (err) {
          setup.htf_error = err.message;
        }
      }

      // Switch back to primary timeframe for chart restore
      try {
        await chart.setTimeframe({ timeframe: default_timeframe });
      } catch (_) {}
    } catch (err) {
      // HTF pass failed — continue without it
      process.stderr.write(`[edge] HTF pass failed: ${err.message}\n`);
    }
  }

  // --- STEP 2c: MULTI-TIMEFRAME AGREEMENT GATE ---
  // Require 1m + 5m + 15m to agree on direction before play qualifies.
  // This is the final gate — if any timeframe disagrees, block the trade.
  for (const setup of scoredSetups) {
    const tradeDir = setup.scoring.direction;
    if (!tradeDir) continue;

    // 5m direction is what scoreSetup() set
    const tf5m = tradeDir === "CALLS" ? "bullish" : "bearish";

    // 1m direction (set during 1m scan if labels existed)
    const tf1m = setup.tf_1m_structure || null;

    // 15m direction (set during HTF scan)
    const tf15m = setup.htf_structure?.direction || null;

    setup.timeframe_alignment = {
      "1m": tf1m,
      "5m": tf5m,
      "15m": tf15m,
    };

    // Count agreement
    const agreements = [];
    if (tf1m === tf5m) agreements.push("1m+5m");
    if (tf15m === tf5m) agreements.push("5m+15m");
    if (tf1m && tf15m && tf1m === tf15m) agreements.push("1m+15m");

    const allAgree = tf1m === tf5m && tf5m === tf15m;
    const hasDisagreement = (tf1m && tf1m !== tf5m) || (tf15m && tf15m !== tf5m);

    if (!setup.scoring.anti_patterns) setup.scoring.anti_patterns = [];

    if (allAgree) {
      setup.scoring.anti_patterns.push(
        `✓ ALIGNED: All 3 timeframes (1m + 5m + 15m) agree ${tf5m} — highest conviction`
      );
      setup.scoring.timeframe_aligned = true;
    } else if (hasDisagreement) {
      // Check how bad the disagreement is
      if (tf1m && tf15m && tf1m !== tf5m && tf15m !== tf5m) {
        // Both 1m AND 15m disagree with 5m — block entirely
        setup.scoring.anti_patterns.push(
          `BLOCKED: 1m=${tf1m}, 5m=${tf5m}, 15m=${tf15m} — multi-timeframe disagreement, no trade`
        );
        setup.scoring.direction = null;
        setup.scoring.conviction = 0;
        setup.scoring.qualified = false;
      } else if (tf1m && tf1m !== tf5m) {
        // Only 1m disagrees — short-term reversal forming, downgrade conviction
        setup.scoring.anti_patterns.push(
          `WARNING: 1m=${tf1m} vs 5m=${tf5m} — short-term timeframe disagrees, conviction reduced`
        );
        if (setup.scoring.conviction > 3) setup.scoring.conviction = 3;
      } else if (tf15m && tf15m !== tf5m) {
        // Only 15m disagrees — bigger picture against trade, downgrade
        setup.scoring.anti_patterns.push(
          `WARNING: 15m=${tf15m} vs 5m=${tf5m} — higher timeframe disagrees, conviction reduced`
        );
        if (setup.scoring.conviction > 3) setup.scoring.conviction = 3;
      }
    } else if (tf1m === tf5m && !tf15m) {
      setup.scoring.anti_patterns.push(
        `CONFIRMED: 1m + 5m agree ${tf5m} (15m no signal)`
      );
    } else if (tf15m === tf5m && !tf1m) {
      setup.scoring.anti_patterns.push(
        `CONFIRMED: 5m + 15m agree ${tf5m} (1m no signal)`
      );
    }
  }

  // Filter out plays that got blocked by MTF gate
  const stillQualified = scoredSetups.filter(s => s.scoring.qualified !== false && s.scoring.direction);
  scoredSetups.length = 0;
  scoredSetups.push(...stillQualified);

  // --- STEP 3: OPTIONS CONFIRMATION on qualified setups ---
  const plays = [];

  for (const setup of scoredSetups) {
    let optionsData = null;
    if (!skip_options) {
      try {
        optionsData = await options.analyzeSymbol(setup.symbol, {
          maxExpiries: optConfig.max_expiries || 2,
          unusualVolThreshold: optConfig.unusual_threshold || 2.0,
          unusualMinVolume: optConfig.unusual_min_volume || 500,
        });
      } catch (err) {
        optionsData = { error: err.message };
      }
    }

    // Build play card
    const play = buildPlayCard(setup, regimeResult.regime, optionsData, bank, rules);
    plays.push(play);
  }

  // Restore chart
  if (originalSymbol) {
    try {
      await chart.setSymbol({ symbol: originalSymbol });
      if (originalTimeframe) await chart.setTimeframe({ timeframe: originalTimeframe });
    } catch (_) {}
  }

  return {
    success: true,
    generated_at: new Date().toISOString(),
    rules_loaded_from: loadedFrom,
    time_rules: timeRules,
    regime: {
      overall: regimeResult.regime,
      spy: regimeResult.spy,
      qqq: regimeResult.qqq,
    },
    symbols_scanned: scans.length,
    qualified_setups: scoredSetups.length,
    plays,
    // Sort plays by: conviction desc, then no HTF disagreement, then upside_pct desc
    plays_ranked: [...plays].sort((a, b) => {
      // Conviction first
      if (b.conviction !== a.conviction) return b.conviction - a.conviction;
      // HTF agreement beats disagreement
      const aDisagree = a.anti_patterns?.some(p => /HTF disagrees/.test(p)) ? 1 : 0;
      const bDisagree = b.anti_patterns?.some(p => /HTF disagrees/.test(p)) ? 1 : 0;
      if (aDisagree !== bDisagree) return aDisagree - bDisagree;
      // Strong/Weak confirmation beats no confirmation
      const aConfirmed = a.anti_patterns?.some(p => /^CONFIRMED/.test(p)) ? 1 : 0;
      const bConfirmed = b.anti_patterns?.some(p => /^CONFIRMED/.test(p)) ? 1 : 0;
      if (aConfirmed !== bConfirmed) return bConfirmed - aConfirmed;
      // Then upside
      if (a.levels?.no_ceiling && !b.levels?.no_ceiling) return -1;
      if (!a.levels?.no_ceiling && b.levels?.no_ceiling) return 1;
      return (b.levels?.upside_pct || 0) - (a.levels?.upside_pct || 0);
    }).map((p) => ({
      symbol: p.symbol,
      direction: p.direction,
      conviction: p.conviction,
      upside: p.levels?.no_ceiling ? "NO CEILING" : p.levels?.upside_pct ? `${p.levels.upside_pct}%` : "?",
      t1: p.levels?.t1?.label || null,
      t2: p.levels?.t2?.label || null,
      stop: p.levels?.stop_label || null,
      htf_agrees: !p.anti_patterns?.some(ap => /HTF disagrees/.test(ap)),
      weak_target: p.anti_patterns?.find(ap => /^CONFIRMED: Weak/.test(ap)) || null,
    })),
    // TOP PICK — single best play, highest conviction with HTF agreement + Strong/Weak confirmation
    top_pick: (() => {
      const ranked = [...plays].sort((a, b) => {
        if (b.conviction !== a.conviction) return b.conviction - a.conviction;
        const aD = a.anti_patterns?.some(p => /HTF disagrees/.test(p)) ? 1 : 0;
        const bD = b.anti_patterns?.some(p => /HTF disagrees/.test(p)) ? 1 : 0;
        if (aD !== bD) return aD - bD;
        return (b.levels?.upside_pct || 0) - (a.levels?.upside_pct || 0);
      });
      const pick = ranked[0];
      if (!pick) return null;
      return {
        symbol: pick.symbol,
        direction: pick.direction,
        conviction: pick.conviction,
        price: pick.price,
        t1: pick.levels?.t1,
        stop: pick.levels?.stop_label,
        suggested_dte: pick.suggested_dte,
        risk: pick.risk,
        reason: pick.anti_patterns?.filter(p => /^CONFIRMED/.test(p)).join("; ") || "highest conviction setup",
      };
    })(),
    all_scans: scans.map((s) => ({
      symbol: s.symbol,
      score: s.scoring?.score,
      conviction: s.scoring?.conviction,
      direction: s.scoring?.direction,
      qualified: s.scoring?.qualified,
      signals_hit: s.scoring?.signals_hit?.map((h) => h.signal),
      anti_patterns: s.scoring?.anti_patterns,
      error: s.error,
    })),
    risk_rules,
  };
}

// =========================================================================
//  SPATIAL ANALYSIS: Where are the targets and walls?
// =========================================================================

/**
 * Analyze price position relative to all key levels.
 * Returns upside targets (BSL, OB resistance), downside support (SSL, OB demand),
 * room to run %, and whether price is capped or in open air.
 */
function analyzeLevels(signals, price) {
  if (!price || price <= 0) return null;

  // Collect ALL levels above and below price
  const bslAbove = (signals.bsl_ssl.levels || []).filter((l) => l > price * 1.001).sort((a, b) => a - b);
  const sslBelow = (signals.bsl_ssl.levels || []).filter((l) => l < price * 0.999).sort((a, b) => b - a);

  // OB zones above (resistance/supply) and below (support/demand)
  // Combine primary zones + HTF zones for full picture
  const obZones = [...(signals.order_blocks.zones || []), ...(signals.order_blocks.htf_zones || [])];
  // Deduplicate zones by rounding high/low
  const seenZones = new Set();
  const dedupedZones = obZones.filter((z) => {
    const key = `${Math.round(z.high * 100)}:${Math.round(z.low * 100)}`;
    if (seenZones.has(key)) return false;
    seenZones.add(key);
    return true;
  });
  const obAbove = dedupedZones.filter((z) => z.low > price * 1.001).sort((a, b) => a.low - b.low);
  const obBelow = dedupedZones.filter((z) => z.high < price * 0.999).sort((a, b) => b.high - a.high);
  const obAtPrice = dedupedZones.filter((z) => price >= z.low * 0.998 && price <= z.high * 1.002);

  // OB levels (from lines — includes HTF levels already merged)
  const allOBLevels = signals.order_blocks.levels || [];
  const obLevelsAbove = allOBLevels.filter((l) => l > price * 1.002).sort((a, b) => a - b);
  const obLevelsBelow = allOBLevels.filter((l) => l < price * 0.998).sort((a, b) => b - a);

  // FVG zones (includes HTF zones already merged)
  const allFvgZones = signals.fvg.zones || [];
  const fvgAbove = allFvgZones.filter((z) => z.low > price * 1.001).sort((a, b) => a.low - b.low);
  const fvgBelow = allFvgZones.filter((z) => z.high < price * 0.999).sort((a, b) => b.high - a.high);

  // --- UPSIDE TARGETS (for CALLS) ---
  const targets = [];
  const targetSeen = new Set();

  // BSL above = first liquidity target
  for (const lvl of bslAbove.slice(0, 5)) {
    const key = `BSL_${Math.round(lvl * 10)}`;
    if (targetSeen.has(key)) continue;
    targetSeen.add(key);
    targets.push({ price: lvl, type: "BSL", pct: +((lvl - price) / price * 100).toFixed(2), label: `BSL $${lvl.toFixed(2)}` });
  }

  // OB resistance zones above = walls to sell into (5m + 15m merged)
  for (const z of obAbove.slice(0, 8)) {
    const key = `OBZ_${Math.round(z.low * 10)}`;
    if (targetSeen.has(key)) continue;
    targetSeen.add(key);
    targets.push({ price: z.low, type: "OB_resistance", pct: +((z.low - price) / price * 100).toFixed(2), label: `OB wall $${z.low.toFixed(2)}-${z.high.toFixed(2)}` });
  }

  // OB line levels above that aren't already covered by zones
  for (const lvl of obLevelsAbove.slice(0, 6)) {
    const key = `OBL_${Math.round(lvl * 10)}`;
    if (targetSeen.has(key)) continue;
    const nearExisting = targets.some((t) => Math.abs(t.price - lvl) / price < 0.003);
    if (nearExisting) continue;
    targetSeen.add(key);
    targets.push({ price: lvl, type: "OB_level", pct: +((lvl - price) / price * 100).toFixed(2), label: `OB line $${lvl.toFixed(2)}` });
  }

  // IFVG key levels — institutional FVG boundaries (critical targets/support)
  const fvgKeyLevels = signals.fvg.key_levels || [];
  const fvgKeysAbove = fvgKeyLevels.filter((l) => l > price * 1.001).sort((a, b) => a - b);
  const fvgKeysBelow = fvgKeyLevels.filter((l) => l < price * 0.999).sort((a, b) => b - a);

  for (const lvl of fvgKeysAbove.slice(0, 4)) {
    const key = `IFVG_${Math.round(lvl * 10)}`;
    if (targetSeen.has(key)) continue;
    const nearExisting = targets.some((t) => Math.abs(t.price - lvl) / price < 0.002);
    if (nearExisting) continue;
    targetSeen.add(key);
    targets.push({ price: lvl, type: "IFVG_level", pct: +((lvl - price) / price * 100).toFixed(2), label: `IFVG $${lvl.toFixed(2)}` });
  }

  // Sort targets by distance
  targets.sort((a, b) => a.pct - b.pct);

  // --- DOWNSIDE SUPPORT (for stops) ---
  const supports = [];

  for (const lvl of sslBelow.slice(0, 3)) {
    supports.push({ price: lvl, type: "SSL", pct: +((price - lvl) / price * 100).toFixed(2), label: `SSL $${lvl.toFixed(2)}` });
  }
  for (const z of obBelow.slice(0, 4)) {
    supports.push({ price: z.high, type: "OB_demand", pct: +((price - z.high) / price * 100).toFixed(2), label: `OB demand $${z.low.toFixed(2)}-${z.high.toFixed(2)}` });
  }
  for (const z of fvgBelow.slice(0, 3)) {
    supports.push({ price: z.high, type: "FVG_support", pct: +((price - z.high) / price * 100).toFixed(2), label: `FVG $${z.low.toFixed(2)}-${z.high.toFixed(2)}` });
  }
  // OB line levels below as support
  for (const lvl of obLevelsBelow.slice(0, 3)) {
    const nearExisting = supports.some((s) => Math.abs(s.price - lvl) / price < 0.003);
    if (nearExisting) continue;
    supports.push({ price: lvl, type: "OB_level", pct: +((price - lvl) / price * 100).toFixed(2), label: `OB line $${lvl.toFixed(2)}` });
  }
  // IFVG key levels below as support
  for (const lvl of fvgKeysBelow.slice(0, 3)) {
    const nearExisting = supports.some((s) => Math.abs(s.price - lvl) / price < 0.002);
    if (nearExisting) continue;
    supports.push({ price: lvl, type: "IFVG_level", pct: +((price - lvl) / price * 100).toFixed(2), label: `IFVG $${lvl.toFixed(2)}` });
  }
  supports.sort((a, b) => a.pct - b.pct);

  // --- ROOM TO RUN ---
  const firstResistance = targets[0] || null;
  const firstSupport = supports[0] || null;
  const noCeiling = bslAbove.length === 0 && obAbove.length === 0 && obLevelsAbove.length === 0;
  const upsidePct = firstResistance ? firstResistance.pct : null;
  const downsidePct = firstSupport ? firstSupport.pct : null;

  // Build T1/T2/T3 for calls
  const t1 = targets[0] || null;
  const t2 = targets[1] || null;
  const t3 = targets[2] || null;

  // Build stop level from support
  const stopLevel = firstSupport ? firstSupport.price : null;

  return {
    price,
    no_ceiling: noCeiling,
    upside_pct: upsidePct,
    downside_to_support_pct: downsidePct,
    targets: targets.slice(0, 10),
    supports: supports.slice(0, 4),
    at_ob: obAtPrice.length > 0,
    at_ob_zones: obAtPrice.slice(0, 2),
    t1: t1 ? { price: t1.price, label: t1.label, pct: t1.pct } : null,
    t2: t2 ? { price: t2.price, label: t2.label, pct: t2.pct } : null,
    t3: t3 ? { price: t3.price, label: t3.label, pct: t3.pct } : null,
    stop_level: stopLevel,
    stop_label: firstSupport?.label || null,
  };
}

// =========================================================================
//  PLAY CARD BUILDER
// =========================================================================

function buildPlayCard(setup, regime, optionsData, bankroll, rules) {
  const { symbol, quote, signals, scoring } = setup;
  const price = quote?.last || 0;
  const direction = scoring.direction;

  // DTE selection based on rules
  const dteRules = rules.dte_rules || {};
  let suggestedDte = "1DTE"; // Default
  let maxPremium = Math.min(bankroll * 0.3, 10000); // 30% of bankroll, max $10k

  // --- SPATIAL ANALYSIS: targets, support, room to run ---
  const levels = analyzeLevels(signals, price);

  // Options data parsing
  let optionsConfirmation = null;
  if (optionsData && !optionsData.error) {
    const nearest = optionsData.expiries?.[0];
    optionsConfirmation = {
      spot: optionsData.spot,
      nearest_expiry: nearest?.expiry,
      dte: nearest?.dte,
      max_pain: nearest?.max_pain,
      put_call_ratio: nearest?.put_call?.volume_ratio,
      atm_iv: nearest?.atm_greeks?.call?.iv || nearest?.atm_greeks?.put?.iv,
      atm_delta: nearest?.atm_greeks?.call?.delta,
      atm_call: nearest?.atm_greeks?.call || null,
      atm_put: nearest?.atm_greeks?.put || null,
      unusual_volume: nearest?.unusual_volume?.length || 0,
      unusual_details: nearest?.unusual_volume?.slice(0, 3),
    };

    // IV check
    if (optionsConfirmation.atm_iv && optionsConfirmation.atm_iv > 0.8) {
      optionsConfirmation.iv_warning = "IV > 80% — reduce size, theta will punish wrong direction";
      maxPremium = Math.min(maxPremium, 5000);
    }

    // Adjust DTE based on nearest expiry
    if (nearest?.dte === 0) suggestedDte = "0DTE";
    else if (nearest?.dte === 1) suggestedDte = "1DTE";
    else suggestedDte = `${nearest?.dte}DTE`;
  }

  // Build the card
  return {
    symbol,
    direction,
    suggested_dte: suggestedDte,
    price,
    // === NEW: Spatial analysis — where to enter, target, stop ===
    levels: levels ? {
      no_ceiling: levels.no_ceiling,
      upside_pct: levels.upside_pct,
      t1: levels.t1,
      t2: levels.t2,
      t3: levels.t3,
      stop_level: levels.stop_level,
      stop_label: levels.stop_label,
      downside_to_support_pct: levels.downside_to_support_pct,
      at_order_block: levels.at_ob,
      all_targets: levels.targets,
      all_supports: levels.supports,
    } : null,
    chart_stack: scoring.signals_hit.map((h) => `✓ ${h.signal}: ${h.detail} — ${h.indicator}`),
    signals_missed: scoring.signals_missed,
    conviction: scoring.conviction,
    conviction_stars: "★".repeat(scoring.conviction) + "☆".repeat(5 - scoring.conviction),
    score: `${scoring.score}/6 chart signals`,
    regime_agreement: regime === "bullish" && direction === "CALLS" ? "✓ regime aligned"
      : regime === "bearish" && direction === "PUTS" ? "✓ regime aligned"
      : regime === "neutral" ? "— regime neutral"
      : "⚠ against regime (has sweep+CHoCH override)",
    options_confirmation: optionsConfirmation,
    anti_patterns: scoring.anti_patterns,
    risk: {
      max_premium: `$${maxPremium.toLocaleString()}`,
      stop: levels?.stop_level
        ? `premium -35% OR price below $${levels.stop_level.toFixed(2)} (${levels.stop_label})`
        : direction === "CALLS" ? "premium -35% OR below nearest OB" : "premium -35% OR above nearest OB",
      bankroll: `$${bankroll.toLocaleString()}`,
    },
  };
}

// =========================================================================
//  UPDATED runBrief — now chains into edge scan
// =========================================================================

export async function runBrief({ rules_path } = {}) {
  const { rules, path: loadedFrom } = loadRules(rules_path);
  const {
    watchlist = [],
    default_timeframe = "5",
    prescreener = {},
  } = rules;

  const threshold = prescreener.gap_threshold || 1.5;
  const maxExtras = prescreener.max_extras || 3;

  if (!watchlist.length) {
    throw new Error(
      "rules.json watchlist is empty. Add at least one symbol to your watchlist array.",
    );
  }

  // --- PRE-SCREENER ---
  const externalConfig = rules.external_screeners || {};
  let screenResults = { extras: [], screened: [] };
  try {
    screenResults = await preScreen(watchlist, threshold, maxExtras, externalConfig);
  } catch (err) {
    screenResults = { extras: [], screened: [], error: err.message };
  }

  // Combine: core watchlist + top movers
  const scanList = [...watchlist];
  for (const extra of screenResults.extras) {
    if (!scanList.includes(extra)) {
      scanList.push(extra);
    }
  }

  // Run edge scoring on the combined list
  let edgeResult = null;
  try {
    edgeResult = await runEdge({
      rules_path,
      symbols: scanList.slice(0, 6), // Cap at 6 to avoid timeout
      skip_options: true, // Options added separately for qualified only
    });
  } catch (err) {
    edgeResult = { error: err.message };
  }

  return {
    success: true,
    generated_at: new Date().toISOString(),
    rules_loaded_from: loadedFrom,
    prescreener: {
      threshold_pct: threshold,
      tickers_checked: screenResults.totalChecked || 0,
      sources: screenResults.sources || null,
      movers_found: screenResults.screened.length,
      top_movers: screenResults.screened.slice(0, 15),
      auto_added: screenResults.extras,
      error: screenResults.error || null,
      source_errors: screenResults.sourceErrors || null,
    },
    edge: edgeResult,
    rules: {
      bias_criteria: rules.bias_criteria || null,
      risk_rules: rules.risk_rules || null,
    },
  };
}

// =========================================================================
//  MID-DAY SCAN (updated to use deep scan)
// =========================================================================

export async function runMidDayScan({ rules_path } = {}) {
  const { rules, path: loadedFrom } = loadRules(rules_path);
  const {
    watchlist = [],
    default_timeframe = "5",
    midday_screener = {},
  } = rules;

  const moveThreshold = midday_screener.move_threshold || 2.0;
  const maxScan = midday_screener.max_scan || 5;

  let watchlistData;
  try {
    watchlistData = await watchlistCore.get();
  } catch (err) {
    return {
      success: false,
      error: `Failed to read TradingView watchlist: ${err.message}. Make sure the watchlist panel is open.`,
    };
  }

  const symbols = watchlistData?.symbols || [];
  if (!symbols.length) {
    return {
      success: false,
      error: "Watchlist is empty or panel is closed.",
    };
  }

  // Parse and rank movers
  const allMovers = [];

  for (const item of symbols) {
    const sym = item.symbol || "";
    const changePctRaw = item.change_percent || "";
    const changeRaw = item.change || "";
    const lastRaw = item.last || "";

    const changePct = parseFloat(changePctRaw.replace("%", ""));
    const change = parseFloat(changeRaw.replace(/,/g, ""));
    const last = parseFloat(lastRaw.replace(/,/g, ""));

    if (isNaN(changePct) || isNaN(last)) continue;

    const absChange = Math.abs(changePct);
    const cleanSymbol = sym.includes(":") ? sym.split(":")[1] : sym;

    if (absChange >= moveThreshold) {
      allMovers.push({
        symbol: cleanSymbol,
        fullSymbol: sym,
        price: last.toFixed(2),
        change: change.toFixed(2),
        changePct: changePct.toFixed(2),
        absChange,
      });
    }
  }

  allMovers.sort((a, b) => b.absChange - a.absChange);

  // Run edge on top movers
  const toScan = allMovers.slice(0, Math.min(maxScan, 4)).map((m) => m.symbol);

  let edgeResult = null;
  if (toScan.length > 0) {
    try {
      edgeResult = await runEdge({
        rules_path,
        symbols: toScan,
        skip_options: true,
      });
    } catch (err) {
      edgeResult = { error: err.message };
    }
  }

  return {
    success: true,
    generated_at: new Date().toISOString(),
    rules_loaded_from: loadedFrom,
    screener: {
      source: "TradingView watchlist",
      tickers_checked: symbols.length,
      movers_found: allMovers.length,
      move_threshold: moveThreshold,
    },
    top_movers: allMovers.slice(0, 15),
    edge: edgeResult,
  };
}

// =========================================================================
//  SESSION PERSISTENCE
// =========================================================================

export function saveSession({ brief, date } = {}) {
  mkdirSync(SESSIONS_DIR, { recursive: true });

  const dateStr = date || new Date().toISOString().split("T")[0];
  const filePath = join(SESSIONS_DIR, `${dateStr}.json`);

  const existing = existsSync(filePath)
    ? JSON.parse(readFileSync(filePath, "utf8"))
    : {};
  const record = {
    ...existing,
    date: dateStr,
    saved_at: new Date().toISOString(),
    brief,
  };

  writeFileSync(filePath, JSON.stringify(record, null, 2));
  return { success: true, path: filePath, date: dateStr };
}

export function getSession({ date } = {}) {
  const dateStr = date || new Date().toISOString().split("T")[0];
  const filePath = join(SESSIONS_DIR, `${dateStr}.json`);

  if (existsSync(filePath)) {
    return { success: true, ...JSON.parse(readFileSync(filePath, "utf8")) };
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];
  const yesterdayPath = join(SESSIONS_DIR, `${yesterdayStr}.json`);

  if (existsSync(yesterdayPath)) {
    return {
      success: true,
      note: "No session for today — returning yesterday",
      ...JSON.parse(readFileSync(yesterdayPath, "utf8")),
    };
  }

  return {
    success: false,
    error: `No session found for ${dateStr} or ${yesterdayStr}`,
    sessions_dir: SESSIONS_DIR,
  };
}
