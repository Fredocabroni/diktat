import * as React from 'react';

/**
 * Mythic — layered emblem. Two stacked stars with offset rotation read as
 * an iridescent diamond at small sizes; the outer TierBadge applies the
 * holographic gradient backdrop and `--hue` animation around it.
 */
export function MythicEmblem(): React.ReactElement {
  return (
    <svg
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      width="100%"
      height="100%"
      aria-hidden
    >
      <g transform="rotate(36 32 32)">
        <path
          d="M32 6 L38 26 L58 26 L42 38 L48 58 L32 46 L16 58 L22 38 L6 26 L26 26 Z"
          fill="currentColor"
          opacity="0.45"
        />
      </g>
      <path
        d="M32 6 L38 26 L58 26 L42 38 L48 58 L32 46 L16 58 L22 38 L6 26 L26 26 Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="32" cy="32" r="4" fill="currentColor" opacity="0.9" />
    </svg>
  );
}
