export type Candle = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
};

export type Side = "buy" | "sell";
export type Pattern = "pin" | "engulf" | "reject" | "soft";
export type Sensitivity = "strict" | "standard" | "loose";
export type SwingKind = "pivot" | "range";

export type Levels = {
  swingHigh: number;
  swingLow: number;
  swingHighIndex: number;
  swingLowIndex: number;
  swingHighKind: SwingKind;
  swingLowKind: SwingKind;
  atr: number;
};

export type Setup = {
  side: Side;
  pattern: Pattern;
  entry: number;
  stop: number;
  takeProfit: number;
  riskReward: number;
  riskPct: number;
  swingHigh: number;
  swingLow: number;
  swingHighIndex: number;
  swingLowIndex: number;
  zone: number;
  atr: number;
  barsAgo: number;
  note: string;
};

export type Analysis = {
  levels: Levels | null;
  setup: Setup | null;
  near: "high" | "low" | null;
  nearDistancePct: number | null;
};

const TOUCH = 3;

const SENS: Record<
  Sensitivity,
  { wing: number; zoneAtr: number; zonePct: number; awayAtr: number; allow: Pattern[] }
> = {
  strict: {
    wing: 3,
    zoneAtr: 0.28,
    zonePct: 0.0014,
    awayAtr: 1,
    allow: ["pin", "engulf"],
  },
  standard: {
    wing: 2,
    zoneAtr: 0.45,
    zonePct: 0.0022,
    awayAtr: 0.65,
    allow: ["pin", "engulf", "reject"],
  },
  loose: {
    wing: 2,
    zoneAtr: 0.7,
    zonePct: 0.0035,
    awayAtr: 0.4,
    allow: ["pin", "engulf", "reject", "soft"],
  },
};

const PATTERN_FA: Record<Pattern, string> = {
  pin: "پین بار",
  engulf: "کندل اینگالف",
  reject: "ریجکت کلوز",
  soft: "برگشت نرم",
};

export function candlesFromTuples(rows: number[][]): Candle[] {
  const out: Candle[] = [];
  for (const row of rows) {
    if (row.length < 5) continue;
    const candle = { t: row[0], o: row[1], h: row[2], l: row[3], c: row[4] };
    if (
      [candle.t, candle.o, candle.h, candle.l, candle.c].every((n) => Number.isFinite(n)) &&
      candle.h >= candle.l
    ) {
      out.push(candle);
    }
  }
  return out;
}

export function analyze(
  candles: Candle[],
  sensitivity: Sensitivity,
  rrInput: number,
): Analysis {
  const empty: Analysis = { levels: null, setup: null, near: null, nearDistancePct: null };
  if (candles.length < 40) return empty;

  const rr = clamp(rrInput, 1, 5);
  const cfg = SENS[sensitivity];
  const atr = wilderAtr(candles, 14);
  const hi = findExtreme(candles, cfg.wing, "high");
  const lo = findExtreme(candles, cfg.wing, "low");
  if (!hi || !lo || hi.price <= lo.price) return empty;

  const levels: Levels = {
    swingHigh: hi.price,
    swingLow: lo.price,
    swingHighIndex: hi.index,
    swingLowIndex: lo.index,
    swingHighKind: hi.kind,
    swingLowKind: lo.kind,
    atr,
  };

  const last = candles[candles.length - 1];
  const zone = Math.max(last.c * cfg.zonePct, atr * cfg.zoneAtr, last.c * 0.00045);

  const sell = tryRevert({
    candles,
    side: "sell",
    swingIndex: hi.index,
    level: hi.price,
    zone,
    atr,
    awayAtr: cfg.awayAtr,
    allow: cfg.allow,
    rr,
    levels,
  });
  const buy = tryRevert({
    candles,
    side: "buy",
    swingIndex: lo.index,
    level: lo.price,
    zone,
    atr,
    awayAtr: cfg.awayAtr,
    allow: cfg.allow,
    rr,
    levels,
  });

  const setup = pickSetup(candles, sell, buy);
  if (setup) return { levels, setup, near: null, nearDistancePct: null };

  const band = (zone * 2.6) / last.c;
  const dHigh = (hi.price - last.c) / last.c;
  const dLow = (last.c - lo.price) / last.c;
  const highOk = dHigh >= 0 && dHigh <= band;
  const lowOk = dLow >= 0 && dLow <= band;
  if (highOk && (!lowOk || dHigh <= dLow)) {
    return { levels, setup: null, near: "high", nearDistancePct: dHigh * 100 };
  }
  if (lowOk) {
    return { levels, setup: null, near: "low", nearDistancePct: dLow * 100 };
  }
  return { levels, setup: null, near: null, nearDistancePct: null };
}

function pickSetup(candles: Candle[], sell: Setup | null, buy: Setup | null): Setup | null {
  if (sell && !buy) return sell;
  if (buy && !sell) return buy;
  if (!sell || !buy) return null;
  const n = candles.length;
  const probeHigh = Math.max(...candles.slice(n - TOUCH).map((c) => c.h));
  const probeLow = Math.min(...candles.slice(n - TOUCH).map((c) => c.l));
  const ds = Math.abs(probeHigh - sell.swingHigh) / sell.swingHigh;
  const db = Math.abs(probeLow - buy.swingLow) / buy.swingLow;
  return ds <= db ? sell : buy;
}

function tryRevert(args: {
  candles: Candle[];
  side: Side;
  swingIndex: number;
  level: number;
  zone: number;
  atr: number;
  awayAtr: number;
  allow: Pattern[];
  rr: number;
  levels: Levels;
}): Setup | null {
  const { candles, side, swingIndex, level, zone, atr, awayAtr, allow, rr, levels } = args;
  const n = candles.length;
  const newest = n - 1;
  const oldest = Math.max(0, n - TOUCH);
  for (let i = newest; i >= oldest; i--) {
    const setup = evalAt(candles, {
      side,
      swingIndex,
      level,
      zone,
      atr,
      awayAtr,
      allow,
      rr,
      levels,
      index: i,
    });
    if (!setup) continue;
    const future = candles.slice(i + 1);
    if (side === "sell") {
      if (future.some((c) => c.c > level || c.l <= setup.stop || c.l <= setup.takeProfit)) continue;
    } else if (future.some((c) => c.c < level || c.h >= setup.stop || c.h >= setup.takeProfit)) {
      continue;
    }
    return setup;
  }
  return null;
}

function evalAt(
  candles: Candle[],
  args: {
    side: Side;
    swingIndex: number;
    level: number;
    zone: number;
    atr: number;
    awayAtr: number;
    allow: Pattern[];
    rr: number;
    levels: Levels;
    index: number;
  },
): Setup | null {
  const { side, swingIndex, level, zone, atr, awayAtr, allow, rr, levels, index } = args;
  const touchFrom = Math.max(0, index - (TOUCH - 1));
  if (swingIndex > touchFrom - 3) return null;

  const departed = candles.slice(swingIndex + 1, touchFrom);
  if (departed.length < 2) return null;
  const awayDist = Math.max(atr * awayAtr, zone * 1.5);

  if (side === "sell") {
    const trough = Math.min(...departed.map((c) => c.l));
    if (trough > level - awayDist) return null;
  } else {
    const peak = Math.max(...departed.map((c) => c.h));
    if (peak < level + awayDist) return null;
  }

  const window = candles.slice(touchFrom, index + 1);
  const last = candles[index];
  const prev = candles[index - 1];
  if (!last || !prev) return null;

  let pattern: Pattern | null = null;
  if (side === "sell") {
    const probe = Math.max(...window.map((c) => c.h));
    if (probe < level - zone || probe > level + zone * 1.4) return null;
    if (last.c > level) return null;
    if (window.some((c) => c.c > level + zone * 0.3)) return null;
    pattern = sellPattern(last, prev, probe, level, zone);
  } else {
    const probe = Math.min(...window.map((c) => c.l));
    if (probe > level + zone || probe < level - zone * 1.4) return null;
    if (last.c < level) return null;
    if (window.some((c) => c.c < level - zone * 0.3)) return null;
    pattern = buyPattern(last, prev, probe, level, zone);
  }
  if (!pattern || !allow.includes(pattern)) return null;

  const pad = Math.max(level * 0.0012, atr * 0.18);
  const entry = last.c;
  const stop = side === "sell" ? level + pad : level - pad;
  if (side === "sell" && !(stop > level && stop > entry)) return null;
  if (side === "buy" && !(stop < level && stop < entry)) return null;

  const risk = Math.abs(entry - stop);
  const riskPct = (risk / entry) * 100;
  if (riskPct < 0.08 || riskPct > 8) return null;

  const takeProfit = side === "sell" ? entry - risk * rr : entry + risk * rr;
  if (!(takeProfit > 0) || (side === "sell" ? takeProfit >= entry : takeProfit <= entry)) {
    return null;
  }

  const barsAgo = candles.length - 1 - index;
  const where = side === "sell" ? "سوینگ های" : "سوینگ لو";
  const stopSide = side === "sell" ? "بالاتر از سوینگ های" : "پایین‌تر از سوینگ لو";
  const when =
    barsAgo === 0
      ? "روی آخرین کندل بسته‌شده"
      : `روی ${barsAgo} کندل قبل و هنوز باطل نشده`;
  const note = `قیمت بعد از دور شدن از ${where} دوباره به همان سطح برگشته و با ${PATTERN_FA[pattern]} ${when} برگشت کرده است. ورود روی کلوز کندل سیگنال است. حد ضرر ${stopSide} است و حد سود ${formatRr(rr)} برابر فاصله ورود تا حد ضرر.`;

  return {
    side,
    pattern,
    entry,
    stop,
    takeProfit,
    riskReward: rr,
    riskPct,
    swingHigh: levels.swingHigh,
    swingLow: levels.swingLow,
    swingHighIndex: levels.swingHighIndex,
    swingLowIndex: levels.swingLowIndex,
    zone,
    atr,
    barsAgo,
    note,
  };
}

function sellPattern(
  last: Candle,
  prev: Candle,
  probe: number,
  level: number,
  zone: number,
): Pattern | null {
  const range = last.h - last.l;
  if (range <= 0) return null;
  const body = Math.abs(last.c - last.o);
  const upper = last.h - Math.max(last.o, last.c);
  const bearish = last.c < last.o;
  const closePos = (last.c - last.l) / range;
  const tagged = probe >= level - zone;

  if (
    bearish &&
    upper >= Math.max(body * 1.15, range * 0.35) &&
    upper / range >= 0.4 &&
    closePos <= 0.5 &&
    last.h >= level - zone
  ) {
    return "pin";
  }

  const prevBody = Math.abs(prev.c - prev.o);
  if (
    bearish &&
    prev.c >= prev.o &&
    last.o >= prev.c &&
    last.c <= prev.o &&
    body >= prevBody * 0.85 &&
    tagged
  ) {
    return "engulf";
  }

  if (bearish && last.c < prev.c && closePos <= 0.58 && tagged && last.h >= level - zone) {
    return "reject";
  }

  if (last.c < prev.c && last.c <= level && tagged) return "soft";
  return null;
}

function buyPattern(
  last: Candle,
  prev: Candle,
  probe: number,
  level: number,
  zone: number,
): Pattern | null {
  const range = last.h - last.l;
  if (range <= 0) return null;
  const body = Math.abs(last.c - last.o);
  const lower = Math.min(last.o, last.c) - last.l;
  const bullish = last.c > last.o;
  const closePos = (last.c - last.l) / range;
  const tagged = probe <= level + zone;

  if (
    bullish &&
    lower >= Math.max(body * 1.15, range * 0.35) &&
    lower / range >= 0.4 &&
    closePos >= 0.5 &&
    last.l <= level + zone
  ) {
    return "pin";
  }

  const prevBody = Math.abs(prev.c - prev.o);
  if (
    bullish &&
    prev.c <= prev.o &&
    last.o <= prev.c &&
    last.c >= prev.o &&
    body >= prevBody * 0.85 &&
    tagged
  ) {
    return "engulf";
  }

  if (bullish && last.c > prev.c && closePos >= 0.42 && tagged && last.l <= level + zone) {
    return "reject";
  }

  if (last.c > prev.c && last.c >= level && tagged) return "soft";
  return null;
}

function findExtreme(
  candles: Candle[],
  wing: number,
  kind: "high" | "low",
): { index: number; price: number; kind: SwingKind } | null {
  const n = candles.length;
  const last = n - wing - 1;
  if (last <= wing) return null;

  const pivots: number[] = [];
  for (let i = wing; i <= last; i++) {
    let ok = true;
    for (let j = 1; j <= wing; j++) {
      if (kind === "high") {
        if (!(candles[i].h > candles[i - j].h && candles[i].h > candles[i + j].h)) ok = false;
      } else if (!(candles[i].l < candles[i - j].l && candles[i].l < candles[i + j].l)) {
        ok = false;
      }
      if (!ok) break;
    }
    if (ok) pivots.push(i);
  }

  if (pivots.length) {
    let best = pivots[0];
    for (const i of pivots) {
      if (kind === "high" ? candles[i].h > candles[best].h : candles[i].l < candles[best].l) {
        best = i;
      }
    }
    return {
      index: best,
      price: kind === "high" ? candles[best].h : candles[best].l,
      kind: "pivot",
    };
  }

  let best = wing;
  for (let i = wing + 1; i <= last; i++) {
    if (kind === "high" ? candles[i].h > candles[best].h : candles[i].l < candles[best].l) best = i;
  }
  return {
    index: best,
    price: kind === "high" ? candles[best].h : candles[best].l,
    kind: "range",
  };
}

function wilderAtr(candles: Candle[], period: number): number {
  if (candles.length < 2) return Math.max(candles[0].h - candles[0].l, candles[0].c * 0.001);
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prevClose = candles[i - 1].c;
    trs.push(Math.max(cur.h - cur.l, Math.abs(cur.h - prevClose), Math.abs(cur.l - prevClose)));
  }
  const span = Math.min(period, trs.length);
  let value = trs.slice(0, span).reduce((sum, n) => sum + n, 0) / span;
  for (let i = span; i < trs.length; i++) value = (value * (period - 1) + trs[i]) / period;
  return value;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function formatRr(rr: number): string {
  return Number.isInteger(rr) ? String(rr) : rr.toFixed(1);
}
