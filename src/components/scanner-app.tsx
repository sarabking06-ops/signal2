import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Activity, Info, RefreshCw, Search, Shield, Target } from "lucide-react";
import { CandleChart } from "@/components/candle-chart";
import { formatCompact, formatPct, formatPrice, formatTehran } from "@/lib/market/format";
import { INTERVAL_LABEL, isInterval, type Interval } from "@/lib/market/intervals";
import { getKlines, getUniverse, type UniverseCoin } from "@/lib/market/scan";
import {
  analyze,
  candlesFromTuples,
  type Analysis,
  type Candle,
  type Pattern,
  type Sensitivity,
  type Setup,
} from "@/lib/market/strategy";

type Filter = "signals" | "buy" | "sell" | "near" | "all";

type Row = UniverseCoin & {
  candles: Candle[] | null;
  error: string | null;
};

type Prefs = { interval: Interval; sensitivity: Sensitivity; rr: number };

const PATTERN_LABEL: Record<Pattern, string> = {
  pin: "پین بار",
  engulf: "اینگالف",
  reject: "ریجکت",
  soft: "برگشت نرم",
};

const RR_OPTIONS = [1.5, 2, 3] as const;

function loadPrefs(): Prefs {
  const fallback: Prefs = { interval: "4h", sensitivity: "standard", rr: 2 };
  try {
    const raw = localStorage.getItem("swingpulse.v1");
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      interval: isInterval(parsed.interval) ? parsed.interval : fallback.interval,
      sensitivity:
        parsed.sensitivity === "strict" || parsed.sensitivity === "loose" || parsed.sensitivity === "standard"
          ? parsed.sensitivity
          : fallback.sensitivity,
      rr: parsed.rr === 1.5 || parsed.rr === 2 || parsed.rr === 3 ? parsed.rr : fallback.rr,
    };
  } catch {
    return fallback;
  }
}

export function ScannerApp() {
  const [booted, setBooted] = useState(false);
  const [interval, setInterval] = useState<Interval>("4h");
  const [sensitivity, setSensitivity] = useState<Sensitivity>("standard");
  const [rr, setRr] = useState<number>(2);
  const [filter, setFilter] = useState<Filter>("signals");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [source, setSource] = useState<"mcap" | "volume" | null>(null);
  const [phase, setPhase] = useState<"boot" | "list" | "candles" | "done" | "error">("boot");
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState<string | null>(null);
  const scanId = useRef(0);

  useEffect(() => {
    const prefs = loadPrefs();
    setInterval(prefs.interval);
    setSensitivity(prefs.sensitivity);
    setRr(prefs.rr);
    setBooted(true);
  }, []);

  useEffect(() => {
    if (!booted) return;
    localStorage.setItem("swingpulse.v1", JSON.stringify({ interval, sensitivity, rr }));
  }, [booted, interval, sensitivity, rr]);

  useEffect(() => {
    if (!booted) return;
    const id = ++scanId.current;
    void runScan(id, interval);
    // sensitivity and rr recompute locally
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted, interval]);

  async function runScan(id: number, nextInterval: Interval) {
    setPhase("list");
    setError(null);
    setDone(0);
    setRows([]);
    setSelected(null);
    setMobileOpen(null);
    try {
      const universe = await getUniverse();
      if (id !== scanId.current) return;
      setSource(universe.source);
      setUpdatedAt(universe.fetchedAt);
      const seeded: Row[] = universe.coins.map((coin) => ({ ...coin, candles: null, error: null }));
      setRows(seeded);
      setTotal(seeded.length);
      setPhase("candles");
      await loadInBatches(id, seeded, nextInterval);
      if (id !== scanId.current) return;
      setPhase("done");
      setUpdatedAt(Date.now());
    } catch (err) {
      if (id !== scanId.current) return;
      setPhase("error");
      setError(err instanceof Error ? err.message : "ارتباط با بازار برقرار نشد");
    }
  }

  async function loadInBatches(id: number, seeded: Row[], nextInterval: Interval) {
    const batches: Row[][] = [];
    for (let i = 0; i < seeded.length; i += 8) batches.push(seeded.slice(i, i + 8));
    let cursor = 0;
    let finished = 0;

    async function worker() {
      while (cursor < batches.length) {
        const index = cursor++;
        const batch = batches[index];
        if (!batch || id !== scanId.current) return;
        let result: { rows: { symbol: string; candles: number[][]; error: string | null }[] } | null = null;
        try {
          result = await getKlines({
            data: { symbols: batch.map((coin) => coin.symbol), interval: nextInterval },
          });
        } catch {
          result = {
            rows: batch.map((coin) => ({ symbol: coin.symbol, candles: [], error: "دریافت نشد" })),
          };
        }
        if (id !== scanId.current || !result) return;
        const bySymbol = new Map(result.rows.map((row) => [row.symbol, row]));
        setRows((current) =>
          current.map((row) => {
            const next = bySymbol.get(row.symbol);
            if (!next) return row;
            return {
              ...row,
              candles: next.error ? null : candlesFromTuples(next.candles),
              error: next.error,
            };
          }),
        );
        finished += batch.length;
        setDone(finished);
      }
    }

    await Promise.all([worker(), worker()]);
  }

  const analyzed = useMemo(
    () =>
      rows.map((row) => ({
        ...row,
        analysis: row.candles ? analyze(row.candles, sensitivity, rr) : null,
      })),
    [rows, sensitivity, rr],
  );

  const counts = useMemo(() => {
    let buy = 0;
    let sell = 0;
    let near = 0;
    for (const row of analyzed) {
      if (row.analysis?.setup?.side === "buy") buy += 1;
      else if (row.analysis?.setup?.side === "sell") sell += 1;
      else if (row.analysis?.near) near += 1;
    }
    return { buy, sell, near, scanned: analyzed.filter((row) => row.candles).length };
  }, [analyzed]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return analyzed
      .filter((row) => {
        if (q && !row.symbol.toLowerCase().includes(q) && !row.name.toLowerCase().includes(q)) return false;
        const setup = row.analysis?.setup;
        if (filter === "buy") return setup?.side === "buy";
        if (filter === "sell") return setup?.side === "sell";
        if (filter === "signals") return Boolean(setup);
        if (filter === "near") return !setup && Boolean(row.analysis?.near);
        return true;
      })
      .sort((a, b) => {
        const rank = (row: (typeof analyzed)[number]) => {
          if (row.analysis?.setup) return 0;
          if (row.analysis?.near) return 1;
          if (row.candles) return 2;
          return 3;
        };
        const diff = rank(a) - rank(b);
        if (diff !== 0) return diff;
        return a.rank - b.rank;
      });
  }, [analyzed, filter, query]);

  useEffect(() => {
    if (!visible.length) return;
    if (selected && visible.some((row) => row.symbol === selected)) return;
    const firstSignal = visible.find((row) => row.analysis?.setup) ?? visible[0];
    setSelected(firstSignal.symbol);
  }, [visible, selected]);

  const active = analyzed.find((row) => row.symbol === selected) ?? null;
  const loading = phase === "boot" || phase === "list" || phase === "candles";
  const progress = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : phase === "list" ? 8 : 0;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-5 pb-16 sm:px-6">
      <header className="border-b border-line pb-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Mark />
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold leading-tight text-balance">سوینگ‌پالس</h1>
              <p className="text-xs tracking-wide text-faint">Swing Pulse</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void runScan(++scanId.current, interval)}
            disabled={loading}
            className="inline-flex h-11 shrink-0 items-center gap-2 rounded-card bg-accent px-4 text-sm font-semibold text-bg disabled:opacity-50"
          >
            <RefreshCw className={"size-4 " + (loading ? "motion-safe:animate-spin" : "")} />
            اسکن دوباره
          </button>
        </div>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-pretty text-muted">
          فروش وقتی قیمت به سوینگ های برگردد و کندل برگشتی بسازد؛ خرید وقتی همین کار را روی سوینگ لو بکند.
          ورود روی کلوز، حد ضرر آن‌سوی سوینگ، حد سود به نسبت ریسک.
        </p>
      </header>

      <div className="mt-4 h-1 overflow-hidden rounded-full bg-surface">
        <div
          className="h-full bg-accent transition-[width] duration-200"
          style={{ width: `${phase === "error" ? progress : loading ? Math.max(progress, 6) : 100}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-faint">
        {phase === "error"
          ? "اسکن متوقف شد"
          : loading
            ? phase === "list"
              ? "در حال چیدن ۱۰۰ ارز برتر…"
              : `کندل ${done.toLocaleString("en-US")} از ${total.toLocaleString("en-US")}`
            : `${counts.scanned.toLocaleString("en-US")} نماد روی ۶۰ کندل ${INTERVAL_LABEL[interval]}`}
        {updatedAt ? <span> · به‌روز {formatTehran(updatedAt)} تهران</span> : null}
        {source ? <span> · {source === "mcap" ? "رتبه ارزش بازار" : "رتبه حجم معامله"}</span> : null}
      </p>

      {error ? (
        <p className="mt-4 rounded-card border border-line bg-sell-soft px-4 py-3 text-sm text-fg" role="alert">
          {error}
        </p>
      ) : null}

      <section className="mt-4 flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Segment
            label="تایم‌فریم"
            value={interval}
            options={(["15m", "1h", "4h", "1d"] as Interval[]).map((item) => ({
              id: item,
              label: INTERVAL_LABEL[item],
            }))}
            onChange={setInterval}
          />
          <Segment
            label="حساسیت"
            value={sensitivity}
            options={[
              { id: "strict" as const, label: "سخت" },
              { id: "standard" as const, label: "استاندارد" },
              { id: "loose" as const, label: "حساس" },
            ]}
            onChange={setSensitivity}
          />
          <Segment
            label="سود به ریسک"
            value={rr}
            options={RR_OPTIONS.map((item) => ({ id: item, label: item === 1.5 ? "۱.۵" : item === 2 ? "۲" : "۳" }))}
            onChange={setRr}
          />
        </div>
      </section>

      <section className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="بررسی‌شده" value={String(counts.scanned)} hint={`از ${total || "—"}`} />
        <Stat label="خرید" value={String(counts.buy)} tone="buy" hint="روی سوینگ لو" />
        <Stat label="فروش" value={String(counts.sell)} tone="sell" hint="روی سوینگ های" />
        <Stat label="نزدیک سطح" value={String(counts.near)} tone="accent" hint="هنوز برگشت نکرده" />
      </section>

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <section className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Segment
              label="نمایش"
              value={filter}
              options={[
                { id: "signals" as const, label: "سیگنال" },
                { id: "buy" as const, label: "خرید" },
                { id: "sell" as const, label: "فروش" },
                { id: "near" as const, label: "نزدیک" },
                { id: "all" as const, label: "همه" },
              ]}
              onChange={setFilter}
            />
            <label className="flex h-11 min-w-40 flex-1 items-center gap-2 rounded-card border border-line bg-surface px-3">
              <Search className="size-4 shrink-0 text-faint" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="نماد یا نام"
                className="w-full bg-transparent text-sm outline-none placeholder:text-faint"
              />
            </label>
          </div>

          <ul className="mt-3 flex flex-col gap-2">
            {visible.length === 0 ? (
              <li className="rounded-card border border-line bg-surface px-4 py-8 text-center">
                <p className="text-sm font-medium">
                  {loading ? "هنوز سیگنالی از این بچ نرسیده." : "با این فیلتر چیزی پیدا نشد."}
                </p>
                <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted">
                  {counts.near > 0
                    ? `${counts.near} ارز به سوینگ نزدیک‌اند ولی کندل برگشتی‌شان هنوز بسته نشده.`
                    : "یا بازار از سقف و کف ۶۰ کندل فاصله دارد، یا حساسیت را روی «حساس» بگذارید."}
                </p>
                {!loading && counts.near > 0 && filter !== "near" ? (
                  <button
                    type="button"
                    onClick={() => setFilter("near")}
                    className="mt-4 h-11 rounded-card border border-line px-4 text-sm"
                  >
                    دیدن نزدیک‌ها
                  </button>
                ) : null}
              </li>
            ) : (
              visible.map((row) => (
                <li key={row.symbol}>
                  <SignalRow
                    row={row}
                    active={row.symbol === selected}
                    onSelect={() => {
                      setSelected(row.symbol);
                      setMobileOpen((current) => (current === row.symbol ? null : row.symbol));
                    }}
                  />
                  {mobileOpen === row.symbol ? (
                    <div className="mt-2 lg:hidden">
                      <Detail row={row} interval={interval} />
                    </div>
                  ) : null}
                </li>
              ))
            )}
          </ul>
        </section>

        <aside className="hidden lg:sticky lg:top-4 lg:block">
          {active ? <Detail row={active} interval={interval} /> : <DetailEmpty loading={loading} />}
        </aside>
      </div>

      <details className="mt-6 rounded-card border border-line bg-raised px-4 py-3">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
          <Info className="size-4 text-accent" />
          منطق سیگنال
        </summary>
        <ul className="mt-3 space-y-2 text-sm leading-6 text-muted">
          <li>فقط کندل بسته‌شده حساب می‌شود. کندل در حال ساخت کنار گذاشته شده است.</li>
          <li>سوینگ های، بالاترین پیوت سقف داخل ۶۰ کندل است و سوینگ لو پایین‌ترین پیوت کف. اگر پیوت نباشد، سقف و کف محدوده جایگزین می‌شود.</li>
          <li>پولبک یعنی بعد از ساخت سوینگ، قیمت واقعاً از آن دور شده و در سه کندل اخیر دوباره به ناحیه‌اش برگشته باشد.</li>
          <li>ریورسال یعنی پین بار، اینگالف یا ریجکت کلوز در جهت برگشت. حالت سخت فقط پین و اینگالف را می‌پذیرد.</li>
          <li>فروش فقط وقتی کلوز زیر سوینگ های بماند. خرید فقط وقتی کلوز بالای سوینگ لو بماند.</li>
          <li>حد ضرر فروش بالاتر از سوینگ های است و حد ضرر خرید پایین‌تر از سوینگ لو، به اندازه یک بالشتک از ATR.</li>
          <li>ورود، کلوز کندل سیگنال است. حد سود، همان نسبت انتخابی نسبت به فاصله ورود تا حد ضرر است.</li>
          <li>اگر سیگنال یکی دو کندل قبل ساخته شده باشد و هنوز نه استاپ خورده باشد نه هدف، همچنان نشان داده می‌شود.</li>
        </ul>
      </details>

      <p className="mt-4 text-xs leading-5 text-faint">
        ابزار آموزشی است، نه توصیه خرید و فروش. اسکن لحظه‌ای بازار است و تضمین سود ندارد. استیبل‌کوین و توکن اهرمی از فهرست حذف شده‌اند.
      </p>
    </main>
  );
}

function SignalRow({
  row,
  active,
  onSelect,
}: {
  row: Row & { analysis: Analysis | null };
  active: boolean;
  onSelect: () => void;
}) {
  const setup = row.analysis?.setup ?? null;
  const near = row.analysis?.near ?? null;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={
        "relative flex w-full flex-col gap-3 overflow-hidden rounded-card border border-line bg-surface px-3 py-3 ps-4 text-start " +
        (active ? "ring-1 ring-accent" : "")
      }
    >
      <span
        className={
          "absolute inset-y-0 start-0 w-1 " +
          (setup?.side === "buy" ? "bg-buy" : setup?.side === "sell" ? "bg-sell" : "bg-line")
        }
      />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-semibold">{row.symbol}</span>
            <span className="truncate text-xs text-faint">{row.name}</span>
          </div>
          <p className="mt-1 text-xs text-muted">
            رتبه <span dir="ltr">{row.rank}</span>
            <span className="px-1 text-faint">·</span>
            حجم <span dir="ltr">{formatCompact(row.quoteVolume)}</span>
          </p>
        </div>
        <div className="text-end">
          <div dir="ltr" className="text-sm font-semibold tabular-nums">
            {formatPrice(row.price)}
          </div>
          <div dir="ltr" className={"text-xs tabular-nums " + (row.changePct >= 0 ? "text-buy" : "text-sell")}>
            {formatPct(row.changePct)}
          </div>
        </div>
      </div>
      {setup ? <SetupLine setup={setup} /> : null}
      {!setup && near ? (
        <p className="text-xs text-accent">
          نزدیک سوینگ {near === "high" ? "های" : "لو"}
          {row.analysis?.nearDistancePct != null ? (
            <span dir="ltr"> · {row.analysis.nearDistancePct.toFixed(2)}%</span>
          ) : null}
        </p>
      ) : null}
      {!setup && !near && row.error ? <p className="text-xs text-sell">{row.error}</p> : null}
      {!setup && !near && !row.error && !row.candles ? <p className="text-xs text-faint">در صف کندل…</p> : null}
      {!setup && !near && !row.error && row.candles ? (
        <p className="text-xs text-faint">بدون پولبک‌ریورسال روی سوینگ‌های این پنجره</p>
      ) : null}
    </button>
  );
}

function SetupLine({ setup }: { setup: Setup }) {
  const buy = setup.side === "buy";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <span className={"rounded-full px-2 py-1 font-semibold " + (buy ? "bg-buy-soft text-buy" : "bg-sell-soft text-sell")}>
        {buy ? "خرید" : "فروش"} · {PATTERN_LABEL[setup.pattern]}
      </span>
      <span className="text-muted">
        ورود <span dir="ltr" className="font-medium text-fg tabular-nums">{formatPrice(setup.entry)}</span>
      </span>
      <span className="text-muted">
        ضرر <span dir="ltr" className="font-medium text-fg tabular-nums">{formatPrice(setup.stop)}</span>
      </span>
      <span className="text-muted">
        سود <span dir="ltr" className="font-medium text-fg tabular-nums">{formatPrice(setup.takeProfit)}</span>
      </span>
      <span dir="ltr" className="tabular-nums text-faint">
        ریسک {setup.riskPct.toFixed(2)}%
        {setup.barsAgo > 0 ? ` · ${setup.barsAgo} کندل پیش` : ""}
      </span>
    </div>
  );
}

function Detail({
  row,
  interval,
}: {
  row: Row & { analysis: Analysis | null };
  interval: Interval;
}) {
  const setup = row.analysis?.setup ?? null;
  const levels = row.analysis?.levels ?? null;
  const buy = setup?.side === "buy";
  return (
    <article className="rounded-card border border-line bg-raised p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">
            {row.symbol}
            <span className="ms-2 text-sm font-normal text-muted">{row.name}</span>
          </h2>
          <p className="mt-1 text-xs text-faint">
            ۶۰ کندل {INTERVAL_LABEL[interval]} · رتبه بازار <span dir="ltr">{row.rank}</span>
          </p>
        </div>
        {setup ? (
          <span className={"rounded-full px-3 py-1 text-sm font-semibold " + (buy ? "bg-buy-soft text-buy" : "bg-sell-soft text-sell")}>
            {buy ? "خرید" : "فروش"}
          </span>
        ) : (
          <span className="rounded-full bg-surface-2 px-3 py-1 text-sm text-muted">بدون سیگنال</span>
        )}
      </div>

      <div className="mt-4">
        {row.candles ? (
          <CandleChart
            candles={row.candles}
            setup={setup}
            swingHigh={levels?.swingHigh ?? null}
            swingLow={levels?.swingLow ?? null}
            swingHighIndex={levels?.swingHighIndex ?? null}
            swingLowIndex={levels?.swingLowIndex ?? null}
          />
        ) : (
          <div className="flex h-40 items-center justify-center rounded-card bg-surface text-sm text-muted">
            {row.error ?? "کندل‌ها در راه‌اند"}
          </div>
        )}
      </div>

      {levels ? (
        <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <LevelTile
            label="سوینگ های"
            hint={levels.swingHighKind === "pivot" ? "پیوت سقف" : "سقف محدوده"}
            value={formatPrice(levels.swingHigh)}
            tone="sell"
          />
          <LevelTile
            label="سوینگ لو"
            hint={levels.swingLowKind === "pivot" ? "پیوت کف" : "کف محدوده"}
            value={formatPrice(levels.swingLow)}
            tone="buy"
          />
        </div>
      ) : null}

      {setup ? (
        <>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <TradeStat icon={<Activity className="size-4" />} label="ورود" value={formatPrice(setup.entry)} hint="کلوز سیگنال" />
            <TradeStat
              icon={<Shield className="size-4" />}
              label="حد ضرر"
              value={formatPrice(setup.stop)}
              hint={buy ? "زیر سوینگ لو" : "بالای سوینگ های"}
              tone={buy ? "buy" : "sell"}
            />
            <TradeStat
              icon={<Target className="size-4" />}
              label="حد سود"
              value={formatPrice(setup.takeProfit)}
              hint={`نسبت ${setup.riskReward === 1.5 ? "۱.۵" : setup.riskReward}`}
              tone="accent"
            />
          </div>
          <p className="mt-3 text-sm leading-6 text-pretty text-muted">{setup.note}</p>
          {setup.riskPct > 3 ? (
            <p className="mt-2 text-xs leading-5 text-accent">
              کندل سیگنال از سوینگ دور بسته شده، برای همین فاصله حد ضرر بزرگ است.
            </p>
          ) : null}
          <p className="mt-2 text-xs text-faint">
            الگو: {PATTERN_LABEL[setup.pattern]}
            <span> · ریسک </span>
            <span dir="ltr">{setup.riskPct.toFixed(2)}%</span>
            {setup.barsAgo > 0 ? <span> · {setup.barsAgo} کندل از سیگنال گذشته</span> : <span> · کندل آخر</span>}
          </p>
        </>
      ) : (
        <p className="mt-3 text-sm leading-6 text-muted">
          {row.analysis?.near
            ? `قیمت به سوینگ ${row.analysis.near === "high" ? "های" : "لو"} نزدیک است ولی هنوز کندل برگشتی تأییدشده نساخته. فاصله حدود ${row.analysis.nearDistancePct?.toFixed(2) ?? "—"} درصد.`
            : "در این پنجره، برگشت معتبری دقیقاً روی سوینگ های یا سوینگ لو بسته نشده است."}
        </p>
      )}
    </article>
  );
}

function DetailEmpty({ loading }: { loading: boolean }) {
  return (
    <div className="rounded-card border border-dashed border-line px-4 py-10 text-center text-sm text-muted">
      {loading ? "اولین نمادها که برسند اینجا باز می‌شوند." : "نمادی انتخاب نشده."}
    </div>
  );
}

function LevelTile({
  label,
  hint,
  value,
  tone,
}: {
  label: string;
  hint: string;
  value: string;
  tone: "buy" | "sell";
}) {
  return (
    <div className={"rounded-card px-3 py-2 " + (tone === "buy" ? "bg-buy-soft" : "bg-sell-soft")}>
      <p className="text-xs text-muted">{label}</p>
      <p dir="ltr" className={"mt-1 text-sm font-semibold tabular-nums " + (tone === "buy" ? "text-buy" : "text-sell")}>
        {value}
      </p>
      <p className="text-xs text-faint">{hint}</p>
    </div>
  );
}

function TradeStat({
  icon,
  label,
  value,
  hint,
  tone = "fg",
}: {
  icon: ReactNode;
  label: string;
  value: string;
  hint: string;
  tone?: "fg" | "buy" | "sell" | "accent";
}) {
  const color =
    tone === "buy" ? "text-buy" : tone === "sell" ? "text-sell" : tone === "accent" ? "text-accent" : "text-fg";
  return (
    <div className="rounded-card bg-surface px-2 py-2">
      <p className="flex items-center gap-1 text-xs text-muted">
        {icon}
        {label}
      </p>
      <p dir="ltr" className={"mt-1 text-sm font-semibold tabular-nums " + color}>
        {value}
      </p>
      <p className="text-xs text-faint">{hint}</p>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = "fg",
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "fg" | "buy" | "sell" | "accent";
}) {
  const color =
    tone === "buy" ? "text-buy" : tone === "sell" ? "text-sell" : tone === "accent" ? "text-accent" : "text-fg";
  return (
    <div className="rounded-card border border-line bg-surface px-3 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={"mt-1 text-2xl font-semibold tabular-nums " + color}>{value}</p>
      <p className="text-xs text-faint">{hint}</p>
    </div>
  );
}

function Segment<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-card border border-line bg-raised p-1">
      <span className="px-2 pt-1 text-xs text-faint">{label}</span>
      <div className="flex flex-wrap">
        {options.map((option) => {
          const on = option.id === value;
          return (
            <button
              key={String(option.id)}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(option.id)}
              className={
                "h-11 rounded-lg px-3 text-sm " +
                (on ? "bg-surface-2 font-semibold text-fg" : "text-muted")
              }
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Mark() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true" className="shrink-0">
      <rect width="40" height="40" rx="12" fill="var(--color-surface)" />
      <path d="M8 14h24" stroke="var(--color-sell)" strokeWidth="2" strokeLinecap="round" />
      <path d="M8 27h24" stroke="var(--color-buy)" strokeWidth="2" strokeLinecap="round" />
      <path
        d="M10 23l6-5 5 3 9-8"
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
