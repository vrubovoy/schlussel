// A flat-vector key, in the same construction style as schloss's own
// castle illustration (flat filled shapes, no strokes, one light recess
// tone, one small signature accent mark borrowed from a sibling app's
// color rather than this app's own accent) - part of the same visual
// family, different subject and color.
export function HeroIllustration({ size = 120, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size * (140 / 100)}
      viewBox="0 0 100 140"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Schlüssel"
      className={className}
    >
      {/* Bow (the ring you grip) - outer ring in the darker accent tone,
          inner hole simulated with the light recess tone layered on top
          (same trick schloss's windows use, since SVG shapes here are
          flat fills, not true cutouts). */}
      <circle cx="50" cy="30" r="24" fill="#2563eb" />
      <circle cx="50" cy="30" r="13" fill="#eff6ff" />

      {/* Shaft */}
      <rect x="44" y="50" width="12" height="60" fill="#3b82f6" />

      {/* Teeth */}
      <rect x="56" y="95" width="14" height="8" fill="#2563eb" />
      <rect x="56" y="108" width="10" height="8" fill="#2563eb" />

      {/* Signature sparkle - schloss's own violet, a small cross-service
          wink tying the illustration family together. */}
      <rect x="26" y="10" width="8" height="8" rx="1.5" fill="#863bff" transform="rotate(45 30 14)" />
    </svg>
  )
}
