/**
 * WAYLO wordmark: bold geometric letters + the O as a lens (ring + dot),
 * per the PRD identity notes (black + amber, thick even ring).
 */

export function WayloLogo({
  size = 96,
  glow = false,
}: {
  size?: number;
  glow?: boolean;
}) {
  const letterSize = size * 0.62;
  return (
    <span className="inline-flex items-center" aria-hidden="true">
      <span
        className={`font-heading font-bold tracking-tight text-foreground select-none ${glow ? "amber-glow-text" : ""}`}
        style={{ fontSize: letterSize, lineHeight: 1 }}
      >
        Wayl
      </span>
      <svg
        width={size}
        height={size}
        viewBox="0 0 48 48"
        className="-mt-1 inline-block"
        style={{ marginLeft: size * 0.04, marginRight: size * 0.04 }}
        role="presentation"
      >
        {glow && <circle cx="24" cy="24" r="20" fill="none" stroke="#f5b700" strokeWidth="3" opacity="0.35" />}
        <circle cx="24" cy="24" r="20" fill="none" stroke="#f5b700" strokeWidth="5" />
        <circle cx="24" cy="24" r="7" fill="#f5b700" />
      </svg>
      <span
        className={`font-heading font-bold tracking-tight text-foreground select-none ${glow ? "amber-glow-text" : ""}`}
        style={{ fontSize: letterSize, lineHeight: 1 }}
      >
        o
      </span>
    </span>
  );
}