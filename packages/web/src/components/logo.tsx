// HumSig logo — a chat bubble whose contents are a signal waveform, on the
// violet→fuchsia gradient. The motif says it plainly: human signals distilled
// from AI-agent conversations (the bubble) into one reading (the trace). Vector,
// no external assets.

type Props = {
  size?: number;
  className?: string;
};

export function Logo({ size = 32, className }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      className={"logo-halo " + (className ?? "")}
      aria-hidden
    >
      <defs>
        <linearGradient id="hm-grad" x1="0" y1="0" x2="48" y2="48">
          <stop offset="0%" stopColor="#7c3aed" />
          <stop offset="55%" stopColor="#c026d3" />
          <stop offset="100%" stopColor="#ec4899" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="12" fill="url(#hm-grad)" />
      {/* chat bubble (the conversation) with a soft fill */}
      <path
        d="M12 14h24a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H22l-7 6v-6h-3a3 3 0 0 1-3-3V17a3 3 0 0 1 3-3z"
        fill="white"
        opacity="0.16"
      />
      {/* the signal waveform inside it (the extracted reading) */}
      <path
        d="M14 23h3l2.5-6 3.5 12 3-9 2.5 6 2-3h6"
        stroke="white"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

export function LogoWordmark({ size = 32 }: { size?: number }) {
  return (
    <span className="flex items-center gap-2">
      <Logo size={size} className="h-7 w-7 sm:h-8 sm:w-8" />
      <span className="bg-brand-gradient bg-clip-text text-xl font-bold tracking-tight text-transparent sm:text-2xl">
        HumSig
      </span>
    </span>
  );
}
