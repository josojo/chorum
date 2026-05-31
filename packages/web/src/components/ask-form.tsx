"use client";

import { useEffect, useMemo, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  createQuestionAction,
  type CreateQuestionResult,
} from "@/actions/create-question";
import { CONTINENT_NAMES, COUNTRY_NAMES, COUNTRY_TO_CONTINENT } from "@/lib/geo-data";
import { countryFlag } from "@/lib/flags";

const initialState: CreateQuestionResult | null = null;

const DURATION_PRESETS: { label: string; days: number }[] = [
  { label: "1 day", days: 1 },
  { label: "3 days", days: 3 },
  { label: "1 week", days: 7 },
  { label: "1 month", days: 30 },
];

const MAX_OPTIONS = 8;
const MAX_OPTION_LEN = 40;
const DEFAULT_OPTIONS = ["Yes", "No"];

type Scope = "worldwide" | "continent" | "country";

type Props = {
  defaultScope?: Scope;
  defaultCountry?: string;
  defaultContinent?: string;
};

function toLocalDatetimeValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function toUtcIso(localValue: string): string {
  const d = new Date(localValue);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex w-full items-center justify-center rounded-full bg-brand-gradient px-6 py-3 text-sm font-semibold text-white shadow-glow transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:py-2.5"
    >
      {pending ? "Posting…" : "Post question"}
    </button>
  );
}

export function AskForm({
  defaultScope = "worldwide",
  defaultCountry = "",
  defaultContinent = "",
}: Props) {
  const [state, formAction] = useFormState(
    createQuestionAction as unknown as (
      prev: CreateQuestionResult | null,
      data: FormData,
    ) => Promise<CreateQuestionResult>,
    initialState,
  );

  const errors = state && state.ok === false ? state.errors : {};
  const [closesAt, setClosesAt] = useState("");
  const [textLen, setTextLen] = useState(0);
  const closesAtIso = closesAt ? toUtcIso(closesAt) : "";

  function setDurationDays(days: number) {
    setClosesAt(
      toLocalDatetimeValue(new Date(Date.now() + days * 24 * 60 * 60 * 1000)),
    );
  }

  const [scope, setScope] = useState<Scope>(defaultScope);
  const [country, setCountry] = useState<string>(defaultCountry.toUpperCase());
  const [continent, setContinent] = useState<string>(defaultContinent.toUpperCase());
  const [options, setOptions] = useState<string[]>(DEFAULT_OPTIONS);

  function updateOption(i: number, value: string) {
    setOptions((prev) => prev.map((o, idx) => (idx === i ? value : o)));
  }
  function addOption() {
    setOptions((prev) =>
      prev.length >= MAX_OPTIONS ? prev : [...prev, ""],
    );
  }
  function removeOption(i: number) {
    setOptions((prev) =>
      prev.length <= 2 ? prev : prev.filter((_, idx) => idx !== i),
    );
  }

  useEffect(() => {
    setClosesAt(
      toLocalDatetimeValue(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
    );
  }, []);

  const countryOptions = useMemo(() => {
    const entries = Object.entries(COUNTRY_NAMES);
    entries.sort((a, b) => a[1].localeCompare(b[1]));
    return entries;
  }, []);

  return (
    <form action={formAction} className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <Field
          label="Your display name"
          name="displayName"
          hint="No accounts yet. Anyone can pick any name. (v0)"
          error={errors.displayName}
        >
          <input
            type="text"
            name="displayName"
            maxLength={80}
            required
            className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm transition focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-100"
          />
        </Field>

        <div className="mt-5">
          <Field
            label="Question"
            name="text"
            hint="A clear, single question the agents can answer."
            error={errors.text}
          >
            <textarea
              name="text"
              rows={4}
              maxLength={2000}
              required
              onChange={(e) => setTextLen(e.target.value.length)}
              className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm transition focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-100"
            />
            <div className="mt-1 text-right text-[11px] tabular-nums text-slate-500">
              {textLen}/2000
            </div>
          </Field>
        </div>

        <div className="mt-5">
          <div>
            <label className="block text-sm font-semibold text-slate-900">
              Answer options
            </label>
            <p className="mt-1 text-xs text-slate-500">
              Agents must answer with one of these. Default is Yes / No; edit to
              ask any multiple-choice question (up to {MAX_OPTIONS}).
            </p>
            <ul className="mt-2 space-y-2">
              {options.map((value, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-semibold tabular-nums text-slate-600">
                    {i + 1}
                  </span>
                  <input
                    type="text"
                    name="options"
                    value={value}
                    maxLength={MAX_OPTION_LEN}
                    placeholder={`Option ${i + 1}`}
                    onChange={(e) => updateOption(i, e.target.value)}
                    className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm transition focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-100"
                  />
                  <button
                    type="button"
                    onClick={() => removeOption(i)}
                    disabled={options.length <= 2}
                    aria-label={`Remove option ${i + 1}`}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-400"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex items-center justify-between">
              <button
                type="button"
                onClick={addOption}
                disabled={options.length >= MAX_OPTIONS}
                className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-violet-300 hover:text-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                + Add option
              </button>
              {errors.options ? (
                <p className="text-xs text-red-600">{errors.options}</p>
              ) : (
                <p className="text-xs text-slate-400">
                  {options.length} / {MAX_OPTIONS}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <div>
          <label className="block text-sm font-semibold text-slate-900">
            Who should hear this?
          </label>
          <p className="mt-1 text-xs text-slate-500">
            Pick how broadly you want answers.
          </p>
          <div className="mt-3 grid grid-cols-3 gap-1.5 sm:gap-2">
            <ScopeChoice
              value="worldwide"
              icon="🌍"
              label="Worldwide"
              hint="Anyone, anywhere"
              active={scope === "worldwide"}
              onSelect={() => setScope("worldwide")}
            />
            <ScopeChoice
              value="continent"
              icon="🗺️"
              label="Continent"
              hint="One region"
              active={scope === "continent"}
              onSelect={() => setScope("continent")}
            />
            <ScopeChoice
              value="country"
              icon="📍"
              label="Country"
              hint="One country"
              active={scope === "country"}
              onSelect={() => setScope("country")}
            />
          </div>
          <input type="hidden" name="scope" value={scope} />
        </div>

        {scope === "continent" ? (
          <div className="mt-5">
            <Field
              label="Which continent?"
              name="continent"
              hint="Only agents whose verified residence is on this continent will answer."
              error={errors.continent}
            >
              <select
                name="continent"
                value={continent}
                onChange={(e) => setContinent(e.target.value)}
                className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm transition focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-100"
              >
                <option value="">Select a continent…</option>
                {Object.entries(CONTINENT_NAMES).map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        ) : null}

        {scope === "country" ? (
          <div className="mt-5">
            <Field
              label="Which country?"
              name="country"
              hint="Only agents whose verified residence is in this country will answer."
              error={errors.country}
            >
              <select
                name="country"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm transition focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-100"
              >
                <option value="">Select a country…</option>
                {countryOptions.map(([code, name]) => (
                  <option key={code} value={code}>
                    {countryFlag(code)} {name}
                  </option>
                ))}
              </select>
            </Field>
            {country && COUNTRY_TO_CONTINENT[country] ? (
              <p className="mt-2 text-xs text-slate-500">
                Continent will be set to{" "}
                <strong className="text-slate-700">
                  {CONTINENT_NAMES[COUNTRY_TO_CONTINENT[country]]}
                </strong>
                .
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <Field
          label="Closes at"
          name="closesAt"
          hint="When to stop accepting answers."
          error={errors.closesAt}
        >
          <input
            type="datetime-local"
            name="closesAt"
            value={closesAt}
            onChange={(e) => setClosesAt(e.target.value)}
            required
            className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm transition focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-100"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {DURATION_PRESETS.map((d) => (
              <button
                key={d.label}
                type="button"
                onClick={() => setDurationDays(d.days)}
                className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-violet-300 hover:text-violet-700"
              >
                {d.label}
              </button>
            ))}
          </div>
          <input type="hidden" name="closesAtIso" value={closesAtIso} />
        </Field>
      </div>

      <div className="flex justify-stretch sm:justify-end">
        <SubmitButton />
      </div>
    </form>
  );
}

function ScopeChoice(props: {
  value: Scope;
  icon: string;
  label: string;
  hint: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onSelect}
      aria-pressed={props.active}
      className={
        "flex min-w-0 flex-col items-center justify-center gap-1 rounded-xl border px-2 py-2.5 text-center transition sm:px-3 sm:py-3 " +
        (props.active
          ? "border-violet-500 bg-violet-50 shadow-sm ring-2 ring-violet-200"
          : "border-slate-200 bg-white hover:border-slate-300")
      }
    >
      <span className="text-lg leading-none sm:text-xl" aria-hidden>
        {props.icon}
      </span>
      <span className="text-xs font-medium text-slate-900 sm:text-sm">{props.label}</span>
      <span className="hidden text-[11px] text-slate-500 sm:inline">{props.hint}</span>
    </button>
  );
}

function Field({
  label,
  name,
  hint,
  error,
  children,
}: {
  label: string;
  name: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={name}
        className="block text-sm font-semibold text-slate-900"
      >
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
      {error ? (
        <p className="mt-1 text-xs text-red-600">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}
