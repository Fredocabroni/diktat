import * as React from 'react';

export function SenatorEmblem(): React.ReactElement {
  return (
    <svg
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      width="100%"
      height="100%"
      aria-hidden
    >
      <path d="M12 50 L52 50" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <path
        d="M16 50 L16 28 M24 50 L24 28 M32 50 L32 28 M40 50 L40 28 M48 50 L48 28"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M10 28 L54 28 L32 12 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
