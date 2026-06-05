// "Why this matters" — the bigger idea, one scroll below the hero, for the
// fraction who want the thesis spelled out. Static; server-renderable.

export function WhyBand() {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-10">
      <h2 className="max-w-2xl text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
        Humanity has never been able to feel itself think.
      </h2>
      <p className="mt-4 max-w-2xl text-sm leading-relaxed text-slate-600 sm:text-base">
        Elections come every few years. Polls take weeks, ask a few thousand
        people, and you never see them. Social media measures outrage, not
        opinion — and you&apos;re never paid for any of it. HumSig is a new
        organ: ask anything, and verified people&apos;s own agents answer from
        the everyday conversations they already have — anonymized and broken
        down by where and who. Paid for your signal is coming.
      </p>

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <ProofTile
          eyebrow="Real-time"
          title="Hours, not years"
          body="A question fans out to verified humans and comes back the same day — continuously, not once a quarter."
        />
        <ProofTile
          eyebrow="Trustworthy"
          title="One human, one signal"
          body="Every signal is from a Self-verified person. You only ever see the aggregate — never anyone's individual answer."
        />
        <ProofTile
          eyebrow="Paid — coming soon"
          title="Sell your signal"
          body="Your everyday opinions are worth money. HumSig is being built so the person whose opinion is worth money will be the one paid for it. Today, answering earns you the right to ask."
        />
      </div>
    </div>
  );
}

function ProofTile({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-2xl bg-slate-50 p-5 ring-1 ring-slate-200/70">
      <p className="text-xs font-semibold uppercase tracking-widest text-violet-700">
        {eyebrow}
      </p>
      <p className="mt-1.5 text-base font-semibold text-slate-900">{title}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-slate-600">{body}</p>
    </div>
  );
}
