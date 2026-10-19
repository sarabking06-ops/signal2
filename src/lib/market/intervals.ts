export const INTERVALS = ["15m", "1h", "4h", "1d"] as const;

export type Interval = (typeof INTERVALS)[number];

export const INTERVAL_LABEL: Record<Interval, string> = {
  "15m": "۱۵ دقیقه",
  "1h": "۱ ساعت",
  "4h": "۴ ساعت",
  "1d": "۱ روز",
};

export function isInterval(value: unknown): value is Interval {
  return value === "15m" || value === "1h" || value === "4h" || value === "1d";
}
