"use client";

// Home hero — "human signals from AI-agent conversations". Makes the thesis (a
// real-time, trustworthy, paid feedback organ) visceral, all from real data:
//   • a live "signals captured" counter — the real site-wide answer total, kept
//     fresh by <LiveRefresh/> (server revalidation) and eased to its true value
//   • the real WorldMap, shading the most-answered open question by sentiment
//   • that question's live option result, summed from its public aggregate
//   • a trust strip: verified human · only-the-signal-leaves · paid (future)
// Primary CTA "Share your signal" opens the real onboarding walkthrough.
//
// Degrades cleanly to a zero-data state (no featured question, total 0) so a
// fresh deployment still looks intentional.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { WorldMap } from "@/components/world-map";
import { EarnExplainerDialog } from "@/components/earn-explainer";
import { LiveRefresh } from "@/components/live-refresh";
import { isYesNo, tallyTotal, type OptionTally } from "@/components/options-bar";
import type { FeaturedQuestion } from "@/lib/featured";

type Props = {
  signalsCaptured: number;
  // Honest secondary number under the counter; null when unavailable.
  verifiedPeople: number | null;
  questionsAsked: number;
  featured: FeaturedQuestion | null;
};

// Eases a displayed integer toward `target` over ~700ms. Always lands exactly
// on `target`, so it animates real growth (e.g. when LiveRefresh brings a new
// total) without ever showing an invented number.
function useCountUp(target: number): number {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    const from = fromRef.current;
    if (from === target) return;
    let raf = 0;
    const duration = 700;
    const step = (ts: number) => {
      if (startRef.current === null) startRef.current = ts;
      const t = Math.min(1, (ts - startRef.current) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(from + (target - from) * eased));
      if (t < 1) {
        raf = requestAnimationFrame(step);
      } else {
        fromRef.current = target;
        startRef.current = null;
      }
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      fromRef.current = value;
      startRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  return value;
}

export function PulseHero({
  signalsCaptured,
  verifiedPeople,
  questionsAsked,
  featured,
}: Props) {
  const [earnOpen, setEarnOpen] = useState(false);
  const shown = useCountUp(signalsCaptured);

  return (
    <section className="relative overflow-hidden rounded-3xl border border-slate-200 bg-mesh p-5 shadow-sm sm:p-8">
      <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-fuchsia-200/40 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-28 -left-20 h-64 w-64 rounded-full bg-violet-200/40 blur-3xl" />

      <div className="relative">
        {/* Eyebrow */}
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/70 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
            live
          </span>
          <span className="text-xs font-semibold uppercase tracking-widest text-violet-700">
            Human signals from AI conversations
          </span>
        </div>

        {/* Headline — the brand line; the subhead carries the "how". */}
        <h1 className="mt-3 max-w-2xl text-3xl font-bold leading-tight tracking-tight text-slate-900 sm:text-5xl">
          Where humanity{" "}
          <span className="bg-brand-gradient bg-clip-text text-transparent">
            thinks out loud
          </span>
          .
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-slate-600 sm:text-base">
          You already tell your AI what you think. Your agent infers your take
          from the everyday chats you already have, and shares just the signal —
          verified human, anonymized, aggregated — so the world can finally read
          what people actually believe.{" "}
          <span className="font-medium text-slate-800">
            Your chat never leaves your agent.
          </span>
        </p>

        {/* The pulse: the world map is always the centerpiece — coloured by the
            most-answered open question when one exists, neutral (grey, "no
            votes yet") otherwise, so a fresh deployment still anchors on the
            globe rather than empty space. */}
        <div className="mt-6 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
          {featured ? (
            <Link
              href={`/q/${featured.id}`}
              className="group rounded-2xl bg-white/70 p-3 ring-1 ring-slate-200/70 backdrop-blur transition hover:ring-violet-300"
            >
              <p className="mb-2 px-1 text-xs font-medium text-slate-500">
                Right now, the world is answering:{" "}
                <span className="font-semibold text-slate-800 group-hover:text-violet-700">
                  “{featured.text}”
                </span>
              </p>
              {/* The map is interactive on its own; the wrapping Link still lets
                  a click on empty chrome open the question. */}
              <WorldMap
                continentData={featured.continentData}
                countryData={featured.countryData}
                total={featured.totalAnswers}
                options={featured.options}
              />
            </Link>
          ) : (
            <div className="rounded-2xl bg-white/70 p-3 ring-1 ring-slate-200/70 backdrop-blur">
              <p className="mb-2 px-1 text-xs font-medium text-slate-500">
                The world map fills in as signals arrive.{" "}
                <span className="font-semibold text-slate-800">
                  No signals yet — share the first one.
                </span>
              </p>
              {/* Neutral world: every country greys out until real votes land. */}
              <WorldMap
                continentData={[]}
                countryData={[]}
                total={0}
                options={["yes", "no"]}
              />
            </div>
          )}

          <div className="flex flex-col gap-4">
            {/* Global counter — the real site-wide answer total. */}
            <div className="rounded-2xl bg-white/80 p-5 ring-1 ring-slate-200/70 backdrop-blur">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Signals captured
                </p>
                <LiveRefresh />
              </div>
              <p className="mt-1 bg-brand-gradient bg-clip-text text-4xl font-bold tabular-nums text-transparent">
                {shown.toLocaleString()}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {verifiedPeople !== null ? (
                  <>
                    from{" "}
                    <span className="font-semibold text-slate-700">
                      {verifiedPeople.toLocaleString()}
                    </span>{" "}
                    verified {verifiedPeople === 1 ? "person" : "people"}
                  </>
                ) : (
                  <>
                    across{" "}
                    <span className="font-semibold text-slate-700">
                      {questionsAsked.toLocaleString()}
                    </span>{" "}
                    {questionsAsked === 1 ? "question" : "questions"}
                  </>
                )}{" "}
                · anonymized signals, captured in real time
              </p>
            </div>

            {/* Featured question's live result — real, from its aggregate. */}
            {featured && tallyTotal(featured.tally) > 0 ? (
              <LiveResult
                options={featured.options}
                tally={featured.tally}
              />
            ) : (
              <div className="rounded-2xl bg-white/80 p-5 text-sm text-slate-600 ring-1 ring-slate-200/70 backdrop-blur">
                Be one of the first signals — add your agent and start
                answering, or post a question for the world to weigh in on.
              </div>
            )}
          </div>
        </div>

        {/* CTAs — "Share your signal" leads (supply side grows the organ). */}
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={() => setEarnOpen(true)}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-brand-gradient px-6 py-3 text-base font-semibold text-white shadow-glow transition hover:opacity-95"
          >
            <SignalIcon /> Share your signal
          </button>
          <Link
            href="/ask"
            className="inline-flex items-center justify-center gap-1.5 rounded-full bg-white px-6 py-3 text-base font-semibold text-slate-700 ring-1 ring-slate-200 transition hover:bg-slate-50"
          >
            Ask the world <span aria-hidden>→</span>
          </Link>
          <span className="text-xs text-slate-500 sm:ml-1">
            Free · takes 2 minutes · your agent does the rest
          </span>
        </div>

        {/* Trust strip — trustworthy + (future) paid, in plain language. */}
        <div className="mt-6 grid grid-cols-1 gap-3 border-t border-slate-200/70 pt-5 sm:grid-cols-3">
          <Pillar
            icon={<CheckBadge />}
            title="Verified human"
            body="One real person, one signal — proven with Self. No bots, no troll farms."
          />
          <Pillar
            icon={<MaskIcon />}
            title="Only the signal leaves"
            body="Your conversation stays yours. Just the anonymized answer is shared — never the chat."
          />
          <Pillar
            icon={<SlidersIcon />}
            title="Yours to control"
            body="Your agent answers within the limits you set — veto or override any signal, anytime. Earning for your signal is coming."
          />
        </div>
      </div>

      <EarnExplainerDialog open={earnOpen} onClose={() => setEarnOpen(false)} />
    </section>
  );
}

// Compact live-result bars for the featured question, summed from its public
// per-continent aggregate. Yes/No gets the green/red treatment; N-option polls
// fall back to neutral violet bars in declared order.
function LiveResult({
  options,
  tally,
}: {
  options: string[];
  tally: OptionTally;
}) {
  const total = tallyTotal(tally);
  const yesNo = isYesNo(options);
  const rows = options
    .map((opt) => ({ opt, n: tally[opt] ?? 0 }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 4);

  return (
    <div className="rounded-2xl bg-white/80 p-5 ring-1 ring-slate-200/70 backdrop-blur">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
        Live result
      </p>
      <div className="mt-3 space-y-2.5">
        {rows.map(({ opt, n }, i) => {
          const pct = total > 0 ? Math.round((n / total) * 100) : 0;
          const fill = yesNo
            ? i === 0
              ? "from-emerald-500 to-emerald-600"
              : "from-rose-500 to-rose-600"
            : "from-violet-600 to-fuchsia-600";
          return (
            <div key={opt}>
              <div className="flex items-center justify-between text-[13px]">
                <span className="font-medium capitalize text-slate-700">
                  {opt}
                </span>
                <span className="tabular-nums text-slate-500">{pct}%</span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={"h-full rounded-full bg-gradient-to-r " + fill}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] text-slate-400">
        {total.toLocaleString()} signals · grouped by region
      </p>
    </div>
  );
}

function Pillar({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-violet-50 text-violet-700">
        {icon}
      </span>
      <div>
        <p className="text-sm font-semibold text-slate-900">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-slate-600">{body}</p>
      </div>
    </div>
  );
}

/* ---------- icons ---------- */

function SignalIcon() {
  // A waveform — the "signal" extracted from a conversation.
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M2 10h2.5L7 4l3.2 12L13 8l1.6 2H18"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckBadge() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
      <path
        d="M10 1.5l2.2 1.6 2.7-.2 1 2.5 2.3 1.4-.7 2.6.7 2.6-2.3 1.4-1 2.5-2.7-.2L10 18.5l-2.2-1.6-2.7.2-1-2.5L1.8 13l.7-2.6L1.8 7.8l2.3-1.4 1-2.5 2.7.2L10 1.5z"
        fill="currentColor"
        opacity="0.18"
      />
      <path
        d="M6.5 10.5l2.2 2.2L14 7.2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function MaskIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
      <rect x="3" y="6" width="14" height="7" rx="3.5" fill="currentColor" opacity="0.18" />
      <circle cx="7.2" cy="9.6" r="1.2" fill="currentColor" />
      <circle cx="12.8" cy="9.6" r="1.2" fill="currentColor" />
    </svg>
  );
}

function SlidersIcon() {
  // Sliders — "you set the limits / stay in control".
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
      <path
        d="M3 6h7M14 6h3M3 14h3M10 14h7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="12" cy="6" r="2" fill="currentColor" opacity="0.18" />
      <circle cx="12" cy="6" r="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <circle cx="8" cy="14" r="2" fill="currentColor" opacity="0.18" />
      <circle cx="8" cy="14" r="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
    </svg>
  );
}
