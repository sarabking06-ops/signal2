import type { Candle, Setup } from "@/lib/market/strategy";
import { formatPrice } from "@/lib/market/format";

type Props = {
  candles: Candle[];
  setup: Setup | null;
  swingHigh: number | null;
  swingLow: number | null;
  swingHighIndex: number | null;
  swingLowIndex: number | null;
};

export function CandleChart({
  candles,
  setup,
  swingHigh,
  swingLow,
  swingHighIndex,
  swingLowIndex,
}: Props) {
  if (candles.length < 2) {
    return <p className="text-sm text-muted">کندلی برای نمودار نیست.</p>;
  }

  const width = 640;
  const height = 280;
  const padL = 8;
  const padR = 10;
  const padT = 14;
  const padB = 10;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const hi = Math.max(...candles.map((c) => c.h));
  const lo = Math.min(...candles.map((c) => c.l));
  const gutter = (hi - lo) * 0.12 || hi * 0.008;
  let yMin = lo - gutter;
  let yMax = hi + gutter;
  if (swingHigh != null) yMax = Math.max(yMax, swingHigh);
  if (swingLow != null) yMin = Math.min(yMin, swingLow);
  let tpInView = false;
  if (setup) {
    yMax = Math.max(yMax, setup.stop, setup.entry);
    yMin = Math.min(yMin, setup.stop, setup.entry);
    const span = yMax - yMin || 1;
    tpInView = setup.takeProfit < yMax + span * 0.5 && setup.takeProfit > yMin - span * 0.5;
    if (tpInView) {
      yMax = Math.max(yMax, setup.takeProfit);
      yMin = Math.min(yMin, setup.takeProfit);
    }
  }
  const span = yMax - yMin || 1;
  const yOf = (price: number) => padT + ((yMax - price) / span) * plotH;
  const slot = plotW / candles.length;
  const bodyW = Math.max(2.2, slot * 0.62);
  const signalIndex = setup ? candles.length - 1 - setup.barsAgo : -1;

  const lines: { price: number; color: string; dash?: string }[] = [];
  if (swingHigh != null) lines.push({ price: swingHigh, color: "var(--color-sell)", dash: "5 4" });
  if (swingLow != null) lines.push({ price: swingLow, color: "var(--color-buy)", dash: "5 4" });
  if (setup) {
    lines.push({ price: setup.entry, color: "var(--color-fg)" });
    lines.push({ price: setup.stop, color: setup.side === "sell" ? "var(--color-sell)" : "var(--color-buy)" });
    if (tpInView) lines.push({ price: setup.takeProfit, color: "var(--color-accent)" });
  }

  return (
    <div dir="ltr">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label="نمودار ۶۰ کندل">
        {[0, 1, 2, 3].map((i) => {
          const y = padT + (plotH * i) / 3;
          return (
            <line key={i} x1={padL} x2={padL + plotW} y1={y} y2={y} stroke="var(--color-line)" strokeWidth="1" />
          );
        })}
        {lines.map((line) => (
          <line
            key={line.color + line.price}
            x1={padL}
            x2={padL + plotW}
            y1={yOf(line.price)}
            y2={yOf(line.price)}
            stroke={line.color}
            strokeWidth="1.25"
            strokeDasharray={line.dash}
          />
        ))}
        {candles.map((candle, index) => {
          const x = padL + index * slot + slot / 2;
          const up = candle.c >= candle.o;
          const color = up ? "var(--color-buy)" : "var(--color-sell)";
          const top = Math.min(yOf(candle.o), yOf(candle.c));
          const bh = Math.max(1.4, Math.abs(yOf(candle.c) - yOf(candle.o)));
          return (
            <g key={candle.t}>
              {index === signalIndex ? (
                <rect x={x - slot / 2} y={padT} width={slot} height={plotH} fill="var(--color-accent)" opacity="0.12" />
              ) : null}
              <line x1={x} x2={x} y1={yOf(candle.h)} y2={yOf(candle.l)} stroke={color} strokeWidth="1.25" />
              <rect x={x - bodyW / 2} y={top} width={bodyW} height={bh} fill={color} rx="0.6" />
            </g>
          );
        })}
        {swingHighIndex != null && candles[swingHighIndex] ? (
          <SwingMark x={padL + swingHighIndex * slot + slot / 2} y={yOf(candles[swingHighIndex].h)} up />
        ) : null}
        {swingLowIndex != null && candles[swingLowIndex] ? (
          <SwingMark x={padL + swingLowIndex * slot + slot / 2} y={yOf(candles[swingLowIndex].l)} up={false} />
        ) : null}
      </svg>
      <ul dir="rtl" className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        {swingHigh != null ? <Legend label="سوینگ های" value={formatPrice(swingHigh)} tone="text-sell" /> : null}
        {swingLow != null ? <Legend label="سوینگ لو" value={formatPrice(swingLow)} tone="text-buy" /> : null}
        {setup ? <Legend label="ورود" value={formatPrice(setup.entry)} tone="text-fg" /> : null}
        {setup ? (
          <Legend label="حد ضرر" value={formatPrice(setup.stop)} tone={setup.side === "sell" ? "text-sell" : "text-buy"} />
        ) : null}
        {setup ? <Legend label="حد سود" value={formatPrice(setup.takeProfit)} tone="text-accent" /> : null}
      </ul>
      {setup && !tpInView ? (
        <p className="mt-1 text-xs text-muted">خط حد سود از محدوده کندل‌ها دور است و برای شلوغ نشدن نمودار کشیده نشده.</p>
      ) : null}
    </div>
  );
}

function Legend({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <li className="flex items-baseline justify-between gap-2">
      <span className="text-muted">{label}</span>
      <span dir="ltr" className={"tabular-nums font-medium " + tone}>
        {value}
      </span>
    </li>
  );
}

function SwingMark({ x, y, up }: { x: number; y: number; up: boolean }) {
  const d = up ? `M ${x} ${y - 7} l 3.5 4.5 h -7 z` : `M ${x} ${y + 7} l 3.5 -4.5 h -7 z`;
  return <path d={d} fill={up ? "var(--color-sell)" : "var(--color-buy)"} />;
}
