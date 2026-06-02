// /ask — form to create a question.
//
// Renders a client form (ask-form.tsx) that invokes the createQuestionAction
// server action. The action inserts and redirects to /q/[id].

import { cookies } from "next/headers";
import { AskForm } from "@/components/ask-form";
import { SESSION_COOKIE, verify as verifySession } from "@/lib/self-session";

export const dynamic = "force-dynamic";

type Scope = "worldwide" | "continent" | "country";

function parseScope(raw: string | undefined): Scope {
  if (raw === "continent" || raw === "country" || raw === "worldwide") return raw;
  return "worldwide";
}

export default function AskPage({
  searchParams,
}: {
  searchParams?: { scope?: string; country?: string; continent?: string };
}) {
  const scope = parseScope(searchParams?.scope);
  const country = (searchParams?.country ?? "").toUpperCase();
  const continent = (searchParams?.continent ?? "").toUpperCase();
  const verified = verifySession(cookies().get(SESSION_COOKIE)?.value).valid;

  return (
    <section className="space-y-6 sm:space-y-8">
      <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:rounded-3xl sm:p-8">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-br from-violet-50 via-white to-fuchsia-50"
        />
        <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-violet-200/50 blur-3xl" />
        <div className="relative">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
            Ask a question
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-600">
            Once posted, anyone whose Hermes agent has consented to your topic
            can answer. You&apos;ll see aggregates by demographic predicate —
            with a real-time world map and age-cohort breakdown.
          </p>
        </div>
      </div>
      <AskForm
        defaultScope={scope}
        defaultCountry={country}
        defaultContinent={continent}
        verified={verified}
      />
    </section>
  );
}
