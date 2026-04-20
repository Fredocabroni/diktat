import * as React from 'react';

export function ArchitectEmblem(): React.ReactElement {
  return (
    <svg
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      width="100%"
      height="100%"
      aria-hidden
    >
      <path
        d="M32 6 L56 22 L56 50 L32 58 L8 50 L8 22 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path
        d="M32 6 L32 32 M8 22 L32 32 M56 22 L32 32 M32 32 L32 58"
        stroke="currentColor"
        strokeWidth="2"
        opacity="0.7"
      />
      <circle cx="32" cy="32" r="4" fill="currentColor" />
    </svg>
  );
}
