/**
 * Morning brief core logic with pre-screener.
 * 1. Pre-screens TradingView watchlist for biggest movers (>1.5% change)
 * 2. Auto-adds top 3 movers to the core watchlist for that session
 * 3. Scans combined list on TradingView with all SMC indicators
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as chart from "./chart.js";
import * as data from "./data.js";
import * as watchlistCore from "./watchlist.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../");
const SESSIONS_DIR = join(homedir(), ".tradingview-mcp", "sessions");

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

/**
 * Fetch Yahoo Finance predefined screeners (day_gainers, day_losers, most_actives, etc.)
 * Returns array of {symbol, price, changePct, source}. Works even though Yahoo's v7 quote
 * API is blocked — this uses the v1 screener endpoint which is still public.
 */
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
      // network/timeout — skip this screen
      continue;
    }
  }
  return results;
}

/**
 * Pre-screener: reads TradingView watchlist panel + Yahoo predefined screeners
 * (day_gainers, day_losers, most_actives) for biggest movers. Returns tickers
 * moving > threshold%, deduped, sorted by absolute change size.
 */
async function preScreen(coreWatchlist, threshold = 1.5, maxExtras = 3, externalConfig = {}) {
  const allMovers = [];
  const seen = new Set();
  let tvCount = 0;
  let yahooCount = 0;
  const sourceErrors = [];

  // --- Source 1: TradingView watchlist panel ---
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

  // --- Source 2: Yahoo predefined screeners ---
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

  // Sort by absolute change, biggest movers first
  allMovers.sort((a, b) => b.absGap - a.absGap);

  return {
    totalChecked: tvCount + yahooCount,
    sources: { tv_watchlist: tvCount, yahoo: yahooCount },
    screened: allMovers,
    extras: allMovers.slice(0, maxExtras).map((m) => m.symbol),
    sourceErrors: sourceErrors.length ? sourceErrors : null,
  };
}

export async function runBrief({ rules_path } = {}) {
  const { rules, path: loadedFrom } = loadRules(rules_path);
  const {
    watchlist = [],
    watchlist_full = [],
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

  // --- PRE-SCREENER (TradingView watchlist + Yahoo screeners) ---
  const externalConfig = rules.external_screeners || {};
  let screenResults = { extras: [], screened: [] };
  try {
    screenResults = await preScreen(watchlist, threshold, maxExtras, externalConfig);
  } catch (err) {
    screenResults = { extras: [], screened: [], error: err.message };
  }

  // Combine: core watchlist + top movers from pre-screener (no duplicates)
  const scanList = [...watchlist];
  for (const extra of screenResults.extras) {
    if (!scanList.includes(extra)) {
      scanList.push(extra);
    }
  }

  // Cap chart scan at 3 symbols to avoid MCP timeout (~10s limit)
  // Pre-screener movers are listed in output but only top 3 overall get chart-scanned
  const finalScanList = scanList.slice(0, 3);

  // Save current chart state so we can restore after scanning
  let originalSymbol, originalTimeframe;
  try {
    const currentState = await chart.getState();
    originalSymbol = currentState.symbol;
    originalTimeframe = currentState.resolution;
  } catch (_) {}

  // Set timeframe once before scanning all symbols
  try {
    await chart.setTimeframe({ timeframe: default_timeframe });
    await new Promise((r) => setTimeout(r, 400));
  } catch (_) {}

  const results = [];

  for (const symbol of finalScanList) {
    try {
      await chart.setSymbol({ symbol });
      await new Promise((r) => setTimeout(r, 500));

      const [state, indicators, quote] = await Promise.all([
        chart.getState(),
        data.getStudyValues(),
        data.getQuote({}),
      ]);

      results.push({
        symbol,
        timeframe: default_timeframe,
        auto_added: screenResults.extras.includes(symbol),
        state,
        indicators,
        quote,
      });
    } catch (err) {
      results.push({ symbol, error: err.message });
    }
  }

  // Restore original chart state
  if (originalSymbol) {
    try {
      await chart.setSymbol({ symbol: originalSymbol });
      if (originalTimeframe)
        await chart.setTimeframe({ timeframe: originalTimeframe });
    } catch (_) {}
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
    rules: {
      bias_criteria: rules.bias_criteria || null,
      risk_rules: rules.risk_rules || null,
      notes: rules.notes || null,
    },
    symbols_scanned: results,
    instruction: [
      "For each symbol in symbols_scanned, apply the bias_criteria from rules to the indicator readings.",
      "Symbols with auto_added: true were detected by the pre-screener as big premarket movers — flag these as potential setups.",
      "Output one line per symbol: SYMBOL | BIAS: [bullish/bearish/neutral] | KEY LEVEL: [price] | WATCH: [what to monitor]",
      "End with a one-sentence overall market read.",
      "Be direct. No preamble.",
    ].join(" "),
  };
}

/**
 * Mid-day screener: reads TradingView watchlist for live prices and % change.
 * Finds biggest movers, then auto-scans top ones with SMC indicators.
 * No external API needed — reads directly from TradingView UI.
 */
export async function runMidDayScan({ rules_path } = {}) {
  const { rules, path: loadedFrom } = loadRules(rules_path);
  const {
    watchlist = [],
    default_timeframe = "5",
    midday_screener = {},
  } = rules;

  const moveThreshold = midday_screener.move_threshold || 2.0;
  const maxScan = midday_screener.max_scan || 5;

  // Read live data from TradingView watchlist panel
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
      error: "Watchlist is empty or panel is closed. Open the TradingView watchlist panel and try again.",
    };
  }

  // Parse and rank movers
  const allMovers = [];

  for (const item of symbols) {
    const sym = item.symbol || "";
    const changePctRaw = item.change_percent || "";
    const changeRaw = item.change || "";
    const lastRaw = item.last || "";

    // Parse % change (remove % sign)
    const changePct = parseFloat(changePctRaw.replace("%", ""));
    const change = parseFloat(changeRaw.replace(/,/g, ""));
    const last = parseFloat(lastRaw.replace(/,/g, ""));

    if (isNaN(changePct) || isNaN(last)) continue;

    const absChange = Math.abs(changePct);

    // Strip exchange prefix for cleaner output
    const cleanSymbol = sym.includes(":") ? sym.split(":")[1] : sym;

    if (absChange >= moveThreshold) {
      let signals = [];
      if (absChange >= 5) signals.push("🔥 big mover");
      else if (absChange >= 3) signals.push("strong move");
      else signals.push("moving");

      if (changePct > 0) signals.push("bullish");
      else signals.push("bearish");

      const score = absChange * 2;

      allMovers.push({
        symbol: cleanSymbol,
        fullSymbol: sym,
        price: last.toFixed(2),
        change: change.toFixed(2),
        changePct: changePct.toFixed(2),
        absChange,
        signals,
        score,
      });
    }
  }

  // Sort by absolute change, biggest movers first
  allMovers.sort((a, b) => b.absChange - a.absChange);

  // Pick top movers to deep-scan on TradingView with SMC indicators
  // Cap at 3 to avoid MCP timeout
  const toScan = allMovers
    .slice(0, Math.min(maxScan, 3))
    .map((m) => m.symbol)
    .filter((s) => !watchlist.includes(s));

  // Save current chart state
  let originalSymbol, originalTimeframe;
  try {
    const currentState = await chart.getState();
    originalSymbol = currentState.symbol;
    originalTimeframe = currentState.resolution;
  } catch (_) {}

  // Scan top movers on TradingView with SMC indicators
  const scanResults = [];

  for (const symbol of toScan) {
    try {
      await chart.setSymbol({ symbol });
      await new Promise((r) => setTimeout(r, 600));
      await chart.setTimeframe({ timeframe: default_timeframe });
      await new Promise((r) => setTimeout(r, 600));

      const [state, indicators, quote] = await Promise.all([
        chart.getState(),
        data.getStudyValues(),
        data.getQuote({}),
      ]);

      scanResults.push({
        symbol,
        timeframe: default_timeframe,
        state,
        indicators,
        quote,
      });
    } catch (err) {
      scanResults.push({ symbol, error: err.message });
    }
  }

  // Restore original chart state
  if (originalSymbol) {
    try {
      await chart.setSymbol({ symbol: originalSymbol });
      if (originalTimeframe)
        await chart.setTimeframe({ timeframe: originalTimeframe });
    } catch (_) {}
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
    chart_scans: scanResults,
    instruction: [
      "Review top_movers for the best intraday setups. Focus on tickers with multiple signals and biggest % moves.",
      "For any ticker with chart_scans data, apply bias_criteria from rules to determine direction.",
      "Output: SYMBOL | CHANGE% | PRICE | BIAS | TRADE IDEA",
      "Prioritize tickers showing SMC confluence (liquidity sweep + CHoCH + OB) on the chart scan.",
      "Be direct. No preamble.",
    ].join(" "),
  };
}

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

  // Fall back to yesterday
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
