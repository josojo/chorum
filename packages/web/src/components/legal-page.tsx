// Shared chrome for the static legal pages (/privacy, /terms). Keeps the slate
// palette and card styling consistent with the rest of the app and gives the
// long-form copy readable typography without pulling in a prose plugin.

import type { ReactNode } from "react";

export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-6 sm:space-y-8">
      <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:rounded-3xl sm:p-8">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-br from-violet-50 via-white to-emerald-50"
        />
        <div className="relative">
          <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">{title}</h1>
          <p className="mt-2 text-xs text-slate-500">Last updated {updated}</p>
        </div>
      </div>
      <div className="space-y-6 text-sm leading-relaxed text-slate-600 [&_a]:font-medium [&_a]:text-violet-700 [&_a]:underline-offset-4 hover:[&_a]:underline [&_h2]:mt-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-slate-800 [&_li]:ml-1 [&_strong]:font-semibold [&_strong]:text-slate-700 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5">
        {children}
      </div>
    </section>
  );
}

export function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="space-y-2.5">
      <h2>{heading}</h2>
      {children}
    </div>
  );
}
