import { z } from "zod";
import { jsonResult } from "./_format.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_PATH = resolve(__dirname, "../core/morning.js");

// Dynamic import with cache busting — ensures code edits take effect without server restart
async function loadCore() {
  const cacheBust = `?t=${Date.now()}`;
  const mod = await import(`file://${CORE_PATH}${cacheBust}`);
  return mod;
}

export function registerMorningTools(server) {
  server.tool(
    "morning_brief",
    "Full premarket brief: pre-screens TradingView watchlist + Yahoo screeners for movers, then runs EDGE scoring (reads ALL indicators: breakout channels, BOS/CHoCH labels, order blocks, FVG zones, BSL/SSL levels) on your core watchlist + top movers. Returns regime gate + chart-first scored setups. This is your primary morning tool.",
    {
      rules_path: z
        .string()
        .optional()
        .describe("Optional path to rules.json. Defaults to rules.json in the project root."),
    },
    async ({ rules_path } = {}) => {
      try {
        const core = await loadCore();
        return jsonResult(await core.runBrief({ rules_path }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    },
  );

  server.tool(
    "edge",
    "Hunt asymmetric setups using CHART-FIRST scoring. Reads ALL TradingView indicators on each symbol: (1) Regime gate via Breakout Channels on SPY/QQQ, (2) Deep scan: study values + Pine labels (BOS/CHoCH) + Pine lines (OB levels, BSL/SSL) + Pine boxes (FVG zones), (3) Score 6 signal categories — 3+ required, (4) Options confirmation on qualified setups only. Returns scored play cards. Zero plays if nothing qualifies — never forces a trade.",
    {
      symbols: z
        .array(z.string())
        .optional()
        .describe("Symbols to scan. Defaults to rules.json watchlist."),
      bankroll: z
        .number()
        .optional()
        .describe("Bankroll size for position sizing. Default $25,000."),
      skip_regime: z
        .boolean()
        .optional()
        .describe("Skip SPY/QQQ regime gate (use if you already know regime). Default false."),
      skip_options: z
        .boolean()
        .optional()
        .describe("Skip options analysis on qualified setups. Default false."),
      rules_path: z
        .string()
        .optional()
        .describe("Optional path to rules.json."),
    },
    async ({ symbols, bankroll, skip_regime, skip_options, rules_path } = {}) => {
      try {
        const core = await loadCore();
        return jsonResult(
          await core.runEdge({ rules_path, symbols, skip_regime, skip_options, bankroll }),
        );
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    },
  );

  server.tool(
    "midday_scan",
    "Mid-day screener: scans TradingView watchlist for intraday movers (2%+ change), then runs EDGE scoring on top movers with full indicator reads. Use anytime during market hours to find new setups.",
    {
      rules_path: z
        .string()
        .optional()
        .describe("Optional path to rules.json. Defaults to rules.json in the project root."),
    },
    async ({ rules_path } = {}) => {
      try {
        const core = await loadCore();
        return jsonResult(await core.runMidDayScan({ rules_path }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    },
  );

  server.tool(
    "session_save",
    "Save today's morning brief to ~/.tradingview-mcp/sessions/YYYY-MM-DD.json for future reference.",
    {
      brief: z
        .string()
        .describe("The brief text to save (output from morning_brief after Claude applies the rules)."),
      date: z
        .string()
        .optional()
        .describe("Date string YYYY-MM-DD. Defaults to today."),
    },
    async ({ brief, date } = {}) => {
      try {
        const core = await loadCore();
        return jsonResult(core.saveSession({ brief, date }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    },
  );

  server.tool(
    "session_get",
    "Retrieve a saved session brief. Returns today's if available, otherwise yesterday's.",
    {
      date: z
        .string()
        .optional()
        .describe("Date string YYYY-MM-DD. Defaults to today."),
    },
    async ({ date } = {}) => {
      try {
        const core = await loadCore();
        return jsonResult(core.getSession({ date }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    },
  );
}
