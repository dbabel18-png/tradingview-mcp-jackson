import { z } from "zod";
import { jsonResult } from "./_format.js";
import * as core from "../core/options.js";

export function registerOptionsTools(server) {
  server.tool(
    "options_analysis",
    "Full options analysis for a symbol: max pain, put/call ratios, IV skew (25Δ put vs call), unusual volume (vol/OI > 2), and ATM greeks (delta/gamma/vega/theta) for the nearest 1-2 expiries. Data source: CBOE delayed quotes (~15min). Use to gauge market positioning and pinning levels before entering a trade.",
    {
      symbol: z
        .string()
        .describe("Underlying symbol (e.g. SPY, QQQ, MU, MSFT, AAPL)"),
      max_expiries: z
        .number()
        .optional()
        .describe("How many nearest expiries to analyze. Default 2."),
      unusual_threshold: z
        .number()
        .optional()
        .describe("Vol/OI ratio threshold for unusual volume. Default 2.0"),
      unusual_min_volume: z
        .number()
        .optional()
        .describe("Minimum contract volume to consider for unusual flag. Default 500"),
    },
    async ({ symbol, max_expiries, unusual_threshold, unusual_min_volume } = {}) => {
      try {
        return jsonResult(
          await core.analyzeSymbol(symbol, {
            maxExpiries: max_expiries,
            unusualVolThreshold: unusual_threshold,
            unusualMinVolume: unusual_min_volume,
          })
        );
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    },
  );
}
