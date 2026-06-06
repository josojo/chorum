// Chorum logo — a "chorus ring": short bars of varying length radiating from a
// center, on the indigo→violet→rose gradient. The motif says the name: many
// voices (the bars) gathered into one round assembly (the ring / quorum) that
// resolves to a single signal (the center dot). Vector, no external assets.

type Props = {
  size?: number;
  className?: string;
};

// 12 voices around the ring; outer end fixed at r=8 (y=16), inner end varies so
// the bars read as different "voices". [angle, inner-y, opacity]
const VOICES: [number, number, number][] = [
  [0, 9, 0.95],
  [30, 11, 0.6],
  [60, 10, 0.8],
  [90, 12, 0.55],
  [120, 9, 0.95],
  [150, 11, 0.6],
  [180, 10, 0.8],
  [210, 12, 0.55],
  [240, 9, 0.95],
  [270, 11, 0.6],
  [300, 10, 0.8],
  [330, 12, 0.55],
];

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
        <linearGradient id="ch-grad" x1="0" y1="0" x2="48" y2="48">
          <stop offset="0%" stopColor="#4f46e5" />
          <stop offset="48%" stopColor="#7c3aed" />
          <stop offset="100%" stopColor="#fb7185" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="12" fill="url(#ch-grad)" />
      {/* the chorus: many voices radiating around the ring */}
      <g stroke="white" strokeWidth="2" strokeLinecap="round">
        {VOICES.map(([angle, y, opacity]) => (
          <line
            key={angle}
            x1="24"
            y1={y}
            x2="24"
            y2="16"
            opacity={opacity}
            transform={`rotate(${angle} 24 24)`}
          />
        ))}
      </g>
      {/* the center: one signal, gathered from the many */}
      <circle cx="24" cy="24" r="3.4" fill="white" />
    </svg>
  );
}

export function LogoWordmark({ size = 32 }: { size?: number }) {
  return (
    <span className="flex items-center gap-2">
      <Logo size={size} className="h-7 w-7 sm:h-8 sm:w-8" />
      <span className="bg-brand-gradient bg-clip-text text-xl font-bold tracking-tight text-transparent sm:text-2xl">
        Chorum
      </span>
    </span>
  );
}
