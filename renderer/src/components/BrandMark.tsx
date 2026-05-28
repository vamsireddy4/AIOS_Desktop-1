import React from "react";

type Variant = "filled" | "outline";

/**
 * AIOS Brand Mark — the canonical "dot" logo: a paper-coloured circle with
 * a small ink dot at the centre. Matches assets/icon.svg (the Dock / DMG
 * icon) so the brand reads consistently across the OS icon, the sidebar,
 * the splash card and any future surface.
 *
 * `variant="outline"` flips to an ink-bordered transparent circle for use
 * on light surfaces where the filled paper version would be invisible.
 * `withDot` is preserved (no-op visually; the dot IS the brand) so existing
 * callers don't need a refactor pass.
 */
export function BrandMark({
  size = 32,
  variant = "filled",
  withDot: _withDot = false,
  className,
  title = "AIOS"
}: {
  size?: number;
  variant?: Variant;
  withDot?: boolean;
  className?: string;
  title?: string;
}) {
  const isFilled = variant === "filled";
  const ringFill = isFilled ? "var(--paper, #F3EFE8)" : "transparent";
  const ringStroke = "var(--ink, #1A1A1C)";
  const ringStrokeWidth = isFilled ? 0 : 2;
  const dotFill = "var(--ink, #1A1A1C)";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{ width: size, height: size, flex: "0 0 auto", display: "block" }}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <circle
        cx="32"
        cy="32"
        r={isFilled ? 30 : 29}
        fill={ringFill}
        stroke={ringStroke}
        strokeWidth={ringStrokeWidth}
      />
      <circle cx="32" cy="32" r="8.3" fill={dotFill} />
    </svg>
  );
}
