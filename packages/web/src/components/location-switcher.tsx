"use client";

// Interactive replacement for the static LocationBadge. The home feed already
// honours a `?loc=XX` override (see lib/geo.ts) — this surfaces it: a visitor
// can switch the country whose feed they're viewing, with a searchable list.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Location } from "@/lib/geo";
import { COUNTRY_NAMES } from "@/lib/geo-data";
import { countryFlag } from "@/lib/flags";

type Props = {
  location: Location;
  scope: string;
};

export function LocationSwitcher({ location, scope }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const options = useMemo(() => {
    const entries = Object.entries(COUNTRY_NAMES).sort((a, b) =>
      a[1].localeCompare(b[1]),
    );
    const needle = query.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter(
      ([code, name]) =>
        name.toLowerCase().includes(needle) ||
        code.toLowerCase().includes(needle),
    );
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function choose(code: string) {
    setOpen(false);
    setQuery("");
    router.push(`/?scope=${scope}&loc=${code}`);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch the location you're viewing"
        className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 shadow-sm transition hover:border-violet-300"
      >
        <span className="text-base leading-none" aria-hidden>
          {countryFlag(location.country)}
        </span>
        <span className="font-medium text-slate-900">{location.countryName}</span>
        <span className="text-slate-400">·</span>
        <span className="text-slate-500">{location.continentName}</span>
        <Chevron open={open} />
      </button>

      {open ? (
        <div className="absolute right-0 z-30 mt-2 w-64 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
          <div className="border-b border-slate-100 p-2">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search country…"
              aria-label="Search country"
              className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100"
            />
          </div>
          <ul role="listbox" className="max-h-64 overflow-auto py-1 text-sm">
            {options.map(([code, name]) => {
              const isCurrent = code === location.country;
              return (
                <li key={code}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isCurrent}
                    onClick={() => choose(code)}
                    className={
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left transition hover:bg-violet-50 " +
                      (isCurrent
                        ? "bg-violet-50 font-medium text-violet-800"
                        : "text-slate-700")
                    }
                  >
                    <span aria-hidden>{countryFlag(code)}</span>
                    <span className="truncate">{name}</span>
                  </button>
                </li>
              );
            })}
            {options.length === 0 ? (
              <li className="px-3 py-4 text-center text-xs text-slate-400">
                No matches
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden
      className={"text-slate-400 transition-transform " + (open ? "rotate-180" : "")}
    >
      <path
        d="M5 8l5 5 5-5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
