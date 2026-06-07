// Stats dashboard — presentational. Renders the site-wide numbers from
// fetchPlatformStats() as a grid of cards. Payout figures have no ledger yet
// (no payments table exists), so those cards render an honest "not tracked
// yet" state rather than an invented number.

import type { PlatformStats } from "@/lib/stats";

type Props = { stats: PlatformStats };

function formatInt(n: number | null): string {
  return n === null ? "—" : n.toLocaleString();
}

export function StatsDashboard({ stats }: Props) {
  const avg = stats.avgAnswersPerQuestion;
  const avgLabel =
    avg >= 100 ? Math.round(avg).toLocaleString() : avg.toFixed(1);

  return (
    <section className="space-y-6 sm:space-y-8">
      <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:rounded-3xl sm:p-8">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-br from-violet-50 via-white to-emerald-50"
        />
        <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-emerald-200/40 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -left-16 h-56 w-56 rounded-full bg-violet-200/40 blur-3xl" />
        <div className="relative space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
            Platform stats
          </h1>
          <p className="max-w-xl text-sm text-slate-600">
            Live, site-wide totals. Agent and respondent counts are aggregate
            COUNTs surfaced by the broker — never any individual&apos;s data.
          </p>
          {!stats.brokerOnline && (
            <p className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              Broker offline — showing public question data only
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
        <StatCard
          label="Registered agents"
          value={formatInt(stats.registeredAgents)}
          hint="Verified humans with an active agent"
        />
        <StatCard
          label="Questions asked"
          value={formatInt(stats.questions)}
          hint="All questions ever posted"
        />
        <StatCard
          label="Total answers"
          value={formatInt(stats.totalAnswers)}
          hint="Accepted envelopes across all questions"
        />
        <StatCard
          label="Avg answers / question"
          value={stats.questions ? avgLabel : "—"}
          hint="Across all questions"
        />
        <StatCard
          label="Respondents"
          value={formatInt(stats.respondents)}
          hint="Distinct humans who have answered"
        />
        <StatCard
          label="Answered questions"
          value={formatInt(stats.answeredQuestions)}
          hint="Questions with at least one answer"
        />
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Earnings
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
          <PendingCard
            label="Total payout"
            hint="Sum paid to respondents, all time"
          />
          <PendingCard
            label="Average user earning"
            hint="Total payout ÷ respondents"
          />
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Payouts aren&apos;t tracked yet — there&apos;s no payment ledger in v0.
          These light up once the rewards path lands.
        </p>
      </div>
    </section>
  );
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-2 break-words bg-brand-gradient bg-clip-text text-2xl font-bold tabular-nums text-transparent sm:text-3xl">
        {value}
      </p>
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
    </div>
  );
}

function PendingCard({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          {label}
        </p>
        <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">
          Not tracked yet
        </span>
      </div>
      <p className="mt-2 text-2xl font-bold tabular-nums text-slate-300 sm:text-3xl">—</p>
      <p className="mt-1 text-xs text-slate-400">{hint}</p>
    </div>
  );
}
