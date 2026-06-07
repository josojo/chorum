import Link from "next/link";
import { countryFlag } from "@/lib/flags";
import { CONTINENT_NAMES, COUNTRY_NAMES, type Continent } from "@/lib/geo-data";
import { describeClose, formatAbsoluteUTC, formatRelative } from "@/lib/time";

export type QuestionCardProps = {
  id: string;
  text: string;
  topic: string | null;
  scope: "worldwide" | "continent" | "country";
  country: string | null;
  continent: string | null;
  closesAt: Date;
  createdAt: Date;
  answerCount: number;
};

function ScopePill(props: {
  scope: QuestionCardProps["scope"];
  country: string | null;
  continent: string | null;
}) {
  if (props.scope === "country" && props.country) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">
        <span aria-hidden>{countryFlag(props.country)}</span>
        {COUNTRY_NAMES[props.country] ?? props.country}
      </span>
    );
  }
  if (props.scope === "continent" && props.continent) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-teal-50 px-2 py-0.5 text-xs font-medium text-teal-700">
        <span aria-hidden>🗺️</span>
        {CONTINENT_NAMES[props.continent as Continent] ?? props.continent}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
      <span aria-hidden>🌍</span>
      Worldwide
    </span>
  );
}

export function QuestionCard(props: QuestionCardProps) {
  return (
    <Link
      href={`/q/${props.id}`}
      className="group relative block overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-violet-300 hover:shadow-lg sm:p-5"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 h-full w-1 origin-top scale-y-0 bg-gradient-to-b from-violet-500 to-emerald-500 transition-transform duration-200 group-hover:scale-y-100"
      />
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-base font-semibold text-slate-900 transition group-hover:text-violet-700">
          {props.text}
        </h3>
        <span className="inline-flex shrink-0 items-baseline gap-1 rounded-full bg-gradient-to-br from-slate-900 to-slate-700 px-2.5 py-1 text-xs font-semibold text-white shadow-sm">
          <span className="tabular-nums">{props.answerCount}</span>
          <span className="opacity-80">
            {props.answerCount === 1 ? "answer" : "answers"}
          </span>
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <ScopePill
          scope={props.scope}
          country={props.country}
          continent={props.continent}
        />
        {/* The classifier may assign multiple tokens (space-joined); render
            one pill per token so the asker / reader sees the full label set. */}
        {props.topic
          ? props.topic
              .split(/\s+/)
              .filter((t) => t.length > 0)
              .map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-700"
                >
                  #{t}
                </span>
              ))
          : null}
        <span className="text-slate-300" aria-hidden>
          ·
        </span>
        <span title={formatAbsoluteUTC(props.createdAt)}>
          opened {formatRelative(props.createdAt)}
        </span>
        <ClosePill closesAt={props.closesAt} />
      </div>
    </Link>
  );
}

function ClosePill({ closesAt }: { closesAt: Date }) {
  const { label, urgency } = describeClose(closesAt);
  if (urgency === "soon") {
    return (
      <span
        title={formatAbsoluteUTC(closesAt)}
        className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800"
      >
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" aria-hidden />
        {label}
      </span>
    );
  }
  return (
    <>
      <span className="text-slate-300" aria-hidden>
        ·
      </span>
      <span
        title={formatAbsoluteUTC(closesAt)}
        className={urgency === "closed" ? "text-slate-400" : undefined}
      >
        {label}
      </span>
    </>
  );
}
