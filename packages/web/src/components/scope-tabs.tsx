import Link from "next/link";
import type { Location } from "@/lib/geo";

export type Scope = "worldwide" | "continent" | "country";

type Props = {
  active: Scope;
  counts: Record<Scope, number>;
  location: Location;
};

const SCOPE_ICONS: Record<Scope, string> = {
  worldwide: "🌍",
  continent: "🗺️",
  country: "📍",
};

export function ScopeTabs({ active, counts, location }: Props) {
  const tabs: { scope: Scope; label: string; count: number }[] = [
    { scope: "worldwide", label: "Worldwide", count: counts.worldwide },
    { scope: "continent", label: location.continentName, count: counts.continent },
    { scope: "country", label: location.countryName, count: counts.country },
  ];

  return (
    <nav
      aria-label="Question scope"
      className="grid grid-cols-3 gap-1.5 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-sm sm:gap-2"
    >
      {tabs.map((t) => {
        const isActive = t.scope === active;
        const href =
          t.scope === "worldwide"
            ? `/?scope=worldwide&loc=${location.country}`
            : `/?scope=${t.scope}&loc=${location.country}`;
        return (
          <Link
            key={t.scope}
            href={href}
            aria-current={isActive ? "page" : undefined}
            className={
              "group relative flex min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1.5 py-2.5 text-center text-xs font-medium transition sm:px-3 sm:py-3 sm:text-sm " +
              (isActive
                ? "bg-gradient-to-br from-violet-600 to-rose-600 text-white shadow-md"
                : "text-slate-700 hover:bg-slate-50")
            }
          >
            <span className="text-base leading-none sm:text-lg" aria-hidden>
              {SCOPE_ICONS[t.scope]}
            </span>
            <span className="w-full truncate">{t.label}</span>
            <span
              className={
                "rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none sm:text-[11px] " +
                (isActive
                  ? "bg-white/25 text-white"
                  : "bg-slate-100 text-slate-700 group-hover:bg-slate-200")
              }
            >
              {t.count}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
