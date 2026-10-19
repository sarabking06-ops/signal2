import { createFileRoute } from "@tanstack/react-router";
import { ScannerApp } from "@/components/scanner-app";

export const Route = createFileRoute("/")({
  component: ScannerApp,
  head: () => ({
    meta: [
      { title: "سوینگ‌پالس — اسکنر پولبک‌ریورسال" },
      {
        name: "description",
        content:
          "سیگنال خرید روی سوینگ لو و فروش روی سوینگ های برای ۱۰۰ ارز برتر، بدون استیبل‌کوین، با ورود و حد ضرر و حد سود.",
      },
    ],
  }),
});
