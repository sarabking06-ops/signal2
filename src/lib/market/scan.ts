import { createServerFn } from "@tanstack/react-start";
import { isInterval, type Interval } from "@/lib/market/intervals";

export type UniverseCoin = {
  symbol: string;
  name: string;
  rank: number;
  price: number;
  changePct: number;
  quoteVolume: number;
};

export type UniverseResult = {
  coins: UniverseCoin[];
  source: "mcap" | "volume";
  fetchedAt: number;
};

export type KlineRow = {
  symbol: string;
  candles: number[][];
  error: string | null;
};

const HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];

const STABLES = new Set([
  "USDT", "USDC", "DAI", "BUSD", "TUSD", "FDUSD", "USDP", "USDD", "PYUSD", "GUSD",
  "FRAX", "LUSD", "USDE", "USDS", "USDG", "USD1", "USD0", "USDY", "RLUSD", "GHO",
  "CRVUSD", "SUSD", "MIM", "DOLA", "USDB", "USTC", "EURC", "EURS", "AEUR", "EURT",
  "EURI", "EUR", "USDR", "USDN", "UST", "USDX", "USDK", "HUSD", "CUSD", "ZUSD",
  "OUSD", "ALUSD", "USDM", "USDJ", "XUSD", "BFUSD", "USDP", "GUSD",
]);

const ALIAS: Record<string, string> = {
  MIOTA: "IOTA",
  XBT: "BTC",
  RNDR: "RENDER",
  MATIC: "POL",
};

const cache = new Map<string, { at: number; value: unknown }>();

function readCache<T>(key: string, ttlMs: number): T | null {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at > ttlMs) return null;
  return hit.value as T;
}

function writeCache(key: string, value: unknown) {
  cache.set(key, { at: Date.now(), value });
}

function isExcluded(symbol: string): boolean {
  const s = symbol.toUpperCase();
  if (!/^[A-Z0-9]{2,15}$/.test(s)) return true;
  if (STABLES.has(s)) return true;
  if (s.startsWith("USD") && s.length <= 8) return true;
  if (s.endsWith("USD") && s.length <= 10) return true;
  if (s.length >= 6 && /(UP|DOWN|BULL|BEAR)$/.test(s)) return true;
  return false;
}

async function fetchJson(url: string, ms = 12000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function binanceGet(path: string): Promise<unknown> {
  let last = "بایننس در دسترس نیست";
  for (const host of HOSTS) {
    try {
      return await fetchJson(host + path);
    } catch (error) {
      last = error instanceof Error ? error.message : last;
    }
  }
  throw new Error(last);
}

type Ticker = {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
};

async function loadTickers(): Promise<Map<string, Ticker>> {
  const cached = readCache<Map<string, Ticker>>("tickers", 60_000);
  if (cached) return cached;
  const raw = await binanceGet("/api/v3/ticker/24hr");
  if (!Array.isArray(raw)) throw new Error("فهرست قیمت نامعتبر است");
  const map = new Map<string, Ticker>();
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const ticker = row as Ticker;
    if (typeof ticker.symbol !== "string" || !ticker.symbol.endsWith("USDT")) continue;
    map.set(ticker.symbol, ticker);
  }
  writeCache("tickers", map);
  return map;
}

type LoreCoin = { symbol: string; name: string; rank: number };

async function loadCoinlore(): Promise<LoreCoin[]> {
  const cached = readCache<LoreCoin[]>("lore", 5 * 60_000);
  if (cached) return cached;
  const pages = await Promise.all(
    [0, 100].map((start) =>
      fetchJson(`https://api.coinlore.net/api/tickers/?start=${start}&limit=100`),
    ),
  );
  const coins: LoreCoin[] = [];
  for (const page of pages) {
    const data = (page as { data?: unknown }).data;
    if (!Array.isArray(data)) continue;
    for (const row of data) {
      if (!row || typeof row !== "object") continue;
      const item = row as { symbol?: unknown; name?: unknown; rank?: unknown };
      if (typeof item.symbol !== "string" || typeof item.name !== "string") continue;
      coins.push({
        symbol: item.symbol.toUpperCase(),
        name: item.name,
        rank: Number(item.rank) || coins.length + 1,
      });
    }
  }
  if (coins.length < 30) throw new Error("رتبه‌بندی ارزش بازار ناقص است");
  writeCache("lore", coins);
  return coins;
}

function coinFromTicker(base: string, ticker: Ticker, name: string, rank: number): UniverseCoin {
  return {
    symbol: base,
    name,
    rank,
    price: Number(ticker.lastPrice),
    changePct: Number(ticker.priceChangePercent),
    quoteVolume: Number(ticker.quoteVolume),
  };
}

async function loadUniverse(): Promise<UniverseResult> {
  const cached = readCache<UniverseResult>("universe", 90_000);
  if (cached) return cached;

  const tickers = await loadTickers();
  let coins: UniverseCoin[] = [];
  let source: UniverseResult["source"] = "mcap";

  try {
    const ranked = await loadCoinlore();
    const seen = new Set<string>();
    for (const coin of ranked) {
      if (coins.length >= 100) break;
      if (isExcluded(coin.symbol) || seen.has(coin.symbol)) continue;
      const base = ALIAS[coin.symbol] ?? coin.symbol;
      if (isExcluded(base) || seen.has(base)) continue;
      const ticker = tickers.get(base + "USDT");
      if (!ticker) continue;
      seen.add(base);
      coins.push(coinFromTicker(base, ticker, coin.name, coin.rank));
    }
  } catch {
    coins = [];
  }

  if (coins.length < 40) {
    source = "volume";
    const ranked = [...tickers.values()].sort(
      (a, b) => Number(b.quoteVolume) - Number(a.quoteVolume),
    );
    coins = [];
    for (const ticker of ranked) {
      if (coins.length >= 100) break;
      const base = ticker.symbol.slice(0, -4);
      if (isExcluded(base)) continue;
      coins.push(coinFromTicker(base, ticker, base, coins.length + 1));
    }
  }

  if (!coins.length) throw new Error("هیچ نمادی برای اسکن پیدا نشد");
  const result: UniverseResult = { coins, source, fetchedAt: Date.now() };
  writeCache("universe", result);
  return result;
}

function klineTtl(interval: Interval): number {
  if (interval === "15m") return 30_000;
  if (interval === "1h") return 60_000;
  if (interval === "4h") return 120_000;
  return 5 * 60_000;
}

async function loadKlines(symbol: string, interval: Interval): Promise<number[][]> {
  const key = `k:${interval}:${symbol}`;
  const cached = readCache<number[][]>(key, klineTtl(interval));
  if (cached) return cached;

  const raw = await binanceGet(
    `/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&limit=80`,
  );
  if (!Array.isArray(raw)) throw new Error("کندل نامعتبر");
  const now = Date.now();
  const candles: number[][] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const closeTime = Number(row[6]);
    if (Number.isFinite(closeTime) && closeTime > now) continue;
    const candle = [Number(row[0]), Number(row[1]), Number(row[2]), Number(row[3]), Number(row[4])];
    if (candle.every((n) => Number.isFinite(n))) candles.push(candle);
  }
  const closed = candles.slice(-60);
  if (closed.length < 40) throw new Error("کندل کافی نیست");
  writeCache(key, closed);
  return closed;
}

export const getUniverse = createServerFn({ method: "GET" }).handler(async () => loadUniverse());

export const getKlines = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("درخواست نامعتبر");
    const body = input as { symbols?: unknown; interval?: unknown };
    if (!isInterval(body.interval)) throw new Error("تایم‌فریم نامعتبر");
    if (!Array.isArray(body.symbols) || body.symbols.length === 0 || body.symbols.length > 12) {
      throw new Error("فهرست نماد نامعتبر");
    }
    const symbols = body.symbols.map((symbol) => {
      if (typeof symbol !== "string" || !/^[A-Z0-9]{2,15}$/.test(symbol)) {
        throw new Error("نماد نامعتبر");
      }
      return symbol;
    });
    return { symbols, interval: body.interval };
  })
  .handler(async ({ data }): Promise<{ rows: KlineRow[]; fetchedAt: number }> => {
    const rows = await Promise.all(
      data.symbols.map(async (symbol): Promise<KlineRow> => {
        try {
          const candles = await loadKlines(symbol, data.interval);
          return { symbol, candles, error: null };
        } catch (error) {
          return {
            symbol,
            candles: [],
            error: error instanceof Error ? error.message : "خطا در کندل",
          };
        }
      }),
    );
    return { rows, fetchedAt: Date.now() };
  });
