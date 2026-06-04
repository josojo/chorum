// WorldSignal logo — a globe with radiating broadcast arcs inside the
// violet→fuchsia brand gradient. Vector, no external assets.

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
        <linearGradient id="ws-grad" x1="0" y1="0" x2="48" y2="48">
          <stop offset="0%" stopColor="#7c3aed" />
          <stop offset="55%" stopColor="#c026d3" />
          <stop offset="100%" stopColor="#ec4899" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="12" fill="url(#ws-grad)" />
      {/* Globe — outline, central meridian, equator + parallels. */}
      <g stroke="white" strokeWidth="2" fill="none" strokeLinecap="round">
        <circle cx="21" cy="27" r="10" />
        <ellipse cx="21" cy="27" rx="4.2" ry="10" />
        <line x1="11" y1="27" x2="31" y2="27" />
        <path d="M12.5 22h17M12.5 32h17" opacity="0.85" />
      </g>
      {/* Broadcast arcs radiating from the top-right — the "signal". */}
      <g stroke="white" strokeWidth="2" fill="none" strokeLinecap="round">
        <path d="M30 18a6 6 0 0 1 6-6" opacity="0.95" />
        <path d="M30 13.5a10.5 10.5 0 0 1 10.5-10.5" opacity="0.6" />
      </g>
      <circle cx="30" cy="18" r="2.1" fill="white" />
    </svg>
  );
}

export function LogoWordmark({ size = 32 }: { size?: number }) {
  return (
    <span className="flex items-center gap-2">
      <Logo size={size} className="h-7 w-7 sm:h-8 sm:w-8" />
      <span className="bg-brand-gradient bg-clip-text text-xl font-bold tracking-tight text-transparent sm:text-2xl">
        WorldSignal
      </span>
    </span>
  );
}
