/**
 * Options analytics: max pain, unusual volume, put/call ratio, skew, greeks.
 * Data source: CBOE public delayed-quotes JSON (free, no auth, ~15min delay).
 */

const CBOE_BASE = "https://cdn.cboe.com/api/global/delayed_quotes/options";

/**
 * Parse OCC option symbol like "SPY260413C00500000" into components.
 * Format: ROOT + YYMMDD + C/P + STRIKE*1000 (8 digits)
 */
export function parseOccSymbol(occ) {
  // Find where the date starts (after the root)
  const m = occ.match(/^([A-Z.]+)(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  const [, root, yymmdd, type, strikeRaw] = m;
  const yy = parseInt(yymmdd.slice(0, 2), 10);
  const mm = parseInt(yymmdd.slice(2, 4), 10);
  const dd = parseInt(yymmdd.slice(4, 6), 10);
  const year = 2000 + yy;
  const expiry = new Date(Date.UTC(year, mm - 1, dd));
  const strike = parseInt(strikeRaw, 10) / 1000;
  return {
    root,
    expiry,
    expiryStr: `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`,
    type: type === "C" ? "call" : "put",
    strike,
  };
}

/**
 * Fetch full options chain for a symbol from CBOE.
 */
export async function fetchOptionsChain(symbol) {
  const url = `${CBOE_BASE}/${symbol.toUpperCase()}.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`CBOE ${symbol}: HTTP ${res.status}`);
    const json = await res.json();
    return {
      symbol: json.symbol || symbol,
      timestamp: json.timestamp,
      spot: json.data.current_price,
      change: json.data.price_change,
      changePct: json.data.price_change_percent,
      bid: json.data.bid,
      ask: json.data.ask,
      contracts: json.data.options || [],
    };
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`Failed to fetch ${symbol} chain: ${err.message}`);
  }
}

/**
 * Group contracts by expiry date. Returns Map<expiryStr, {expiryStr, dte, calls, puts}>.
 */
export function groupByExpiry(contracts, asOf = new Date()) {
  const groups = new Map();
  for (const c of contracts) {
    const parsed = parseOccSymbol(c.option);
    if (!parsed) continue;
    if (!groups.has(parsed.expiryStr)) {
      const dte = Math.max(0, Math.round((parsed.expiry - asOf) / 86400000));
      groups.set(parsed.expiryStr, {
        expiryStr: parsed.expiryStr,
        expiry: parsed.expiry,
        dte,
        calls: [],
        puts: [],
      });
    }
    const enriched = { ...c, strike: parsed.strike, type: parsed.type };
    if (parsed.type === "call") groups.get(parsed.expiryStr).calls.push(enriched);
    else groups.get(parsed.expiryStr).puts.push(enriched);
  }
  // Sort each strike list ascending
  for (const g of groups.values()) {
    g.calls.sort((a, b) => a.strike - b.strike);
    g.puts.sort((a, b) => a.strike - b.strike);
  }
  return groups;
}

/**
 * Compute max pain: strike where total $ value of all ITM options at expiry is minimized.
 * (The price the underlying must reach to cause maximum financial loss to option holders.)
 */
export function computeMaxPain(group) {
  const strikes = new Set();
  for (const c of group.calls) strikes.add(c.strike);
  for (const p of group.puts) strikes.add(p.strike);
  const strikeList = [...strikes].sort((a, b) => a - b);

  let minPain = Infinity;
  let maxPainStrike = null;
  const detail = [];

  for (const expiryPrice of strikeList) {
    let totalPain = 0;
    // Calls ITM if strike < expiryPrice
    for (const call of group.calls) {
      if (call.strike < expiryPrice) {
        totalPain += (expiryPrice - call.strike) * (call.open_interest || 0);
      }
    }
    // Puts ITM if strike > expiryPrice
    for (const put of group.puts) {
      if (put.strike > expiryPrice) {
        totalPain += (put.strike - expiryPrice) * (put.open_interest || 0);
      }
    }
    detail.push({ strike: expiryPrice, pain: totalPain });
    if (totalPain < minPain) {
      minPain = totalPain;
      maxPainStrike = expiryPrice;
    }
  }

  return { maxPain: maxPainStrike, totalPain: minPain, strikesAnalyzed: strikeList.length };
}

/**
 * Put/call ratios — both volume and open interest based.
 */
export function computePutCallRatios(group) {
  let callVol = 0, putVol = 0, callOI = 0, putOI = 0;
  for (const c of group.calls) {
    callVol += c.volume || 0;
    callOI += c.open_interest || 0;
  }
  for (const p of group.puts) {
    putVol += p.volume || 0;
    putOI += p.open_interest || 0;
  }
  return {
    pcr_volume: callVol ? +(putVol / callVol).toFixed(3) : null,
    pcr_oi: callOI ? +(putOI / callOI).toFixed(3) : null,
    call_volume: callVol,
    put_volume: putVol,
    call_oi: callOI,
    put_oi: putOI,
  };
}

/**
 * Find unusual volume contracts: vol/OI ratio > threshold (default 2.0).
 * These often indicate institutional positioning or directional bets.
 */
export function findUnusualVolume(group, threshold = 2.0, minVolume = 500) {
  const unusual = [];
  for (const list of [group.calls, group.puts]) {
    for (const c of list) {
      const vol = c.volume || 0;
      const oi = c.open_interest || 0;
      if (vol < minVolume) continue;
      if (oi === 0) continue; // avoid divide by zero
      const ratio = vol / oi;
      if (ratio >= threshold) {
        unusual.push({
          type: c.type,
          strike: c.strike,
          volume: vol,
          open_interest: oi,
          vol_oi_ratio: +ratio.toFixed(2),
          iv: c.iv,
          delta: c.delta,
          last: c.last_trade_price,
        });
      }
    }
  }
  unusual.sort((a, b) => b.vol_oi_ratio - a.vol_oi_ratio);
  return unusual.slice(0, 15);
}

/**
 * Compute volatility skew using 25-delta put vs 25-delta call IV.
 * Positive skew = puts expensive (fear). Negative = calls bid (greed/squeeze).
 */
export function computeSkew(group) {
  // Find call closest to delta 0.25
  let callTarget = null, callBest = Infinity;
  for (const c of group.calls) {
    if (!c.iv || c.delta == null) continue;
    const diff = Math.abs(c.delta - 0.25);
    if (diff < callBest) { callBest = diff; callTarget = c; }
  }
  // Find put closest to delta -0.25
  let putTarget = null, putBest = Infinity;
  for (const p of group.puts) {
    if (!p.iv || p.delta == null) continue;
    const diff = Math.abs(p.delta - (-0.25));
    if (diff < putBest) { putBest = diff; putTarget = p; }
  }
  if (!callTarget || !putTarget) return null;
  const skewPct = ((putTarget.iv - callTarget.iv) * 100).toFixed(2);
  return {
    put_25d_iv: +(putTarget.iv * 100).toFixed(2),
    call_25d_iv: +(callTarget.iv * 100).toFixed(2),
    skew_pct: +skewPct,
    interpretation:
      skewPct > 3 ? "elevated put skew (defensive / hedging)" :
      skewPct > 0 ? "normal put skew" :
      skewPct > -3 ? "flat skew (complacency)" :
      "negative skew (call demand / squeeze)",
    put_strike: putTarget.strike,
    call_strike: callTarget.strike,
  };
}

/**
 * Get the ATM strike's greeks for the nearest expiry.
 */
export function getAtmGreeks(group, spot) {
  const findClosest = (list) => {
    let best = null, bestDiff = Infinity;
    for (const c of list) {
      const d = Math.abs(c.strike - spot);
      if (d < bestDiff) { bestDiff = d; best = c; }
    }
    return best;
  };
  const atmCall = findClosest(group.calls);
  const atmPut = findClosest(group.puts);
  if (!atmCall || !atmPut) return null;
  return {
    atm_strike: atmCall.strike,
    call: {
      delta: atmCall.delta,
      gamma: atmCall.gamma,
      vega: atmCall.vega,
      theta: atmCall.theta,
      iv: +(atmCall.iv * 100).toFixed(2),
      bid: atmCall.bid,
      ask: atmCall.ask,
      volume: atmCall.volume,
      oi: atmCall.open_interest,
    },
    put: {
      delta: atmPut.delta,
      gamma: atmPut.gamma,
      vega: atmPut.vega,
      theta: atmPut.theta,
      iv: +(atmPut.iv * 100).toFixed(2),
      bid: atmPut.bid,
      ask: atmPut.ask,
      volume: atmPut.volume,
      oi: atmPut.open_interest,
    },
  };
}

/**
 * Full options analysis for a symbol: max pain, P/C ratio, skew, unusual vol, ATM greeks.
 * Returns analysis for the nearest 1-2 expiries (most actionable for day trades).
 */
export async function analyzeSymbol(symbol, opts = {}) {
  const { maxExpiries = 2, unusualVolThreshold = 2.0, unusualMinVolume = 500 } = opts;
  const chain = await fetchOptionsChain(symbol);
  const groups = groupByExpiry(chain.contracts);

  // Sort expiries by DTE, take nearest
  const sorted = [...groups.values()].sort((a, b) => a.dte - b.dte);
  const targetExpiries = sorted.slice(0, maxExpiries);

  const expiryAnalysis = targetExpiries.map((g) => ({
    expiry: g.expiryStr,
    dte: g.dte,
    contracts: g.calls.length + g.puts.length,
    max_pain: computeMaxPain(g),
    put_call: computePutCallRatios(g),
    skew: computeSkew(g),
    atm_greeks: getAtmGreeks(g, chain.spot),
    unusual_volume: findUnusualVolume(g, unusualVolThreshold, unusualMinVolume),
  }));

  // Also compute aggregate P/C across all expiries
  const allCalls = [], allPuts = [];
  for (const g of groups.values()) {
    allCalls.push(...g.calls);
    allPuts.push(...g.puts);
  }
  const aggregatePCR = computePutCallRatios({ calls: allCalls, puts: allPuts });

  return {
    symbol: chain.symbol,
    spot: chain.spot,
    change: chain.change,
    changePct: chain.changePct,
    timestamp: chain.timestamp,
    aggregate_put_call: aggregatePCR,
    expiries: expiryAnalysis,
  };
}
