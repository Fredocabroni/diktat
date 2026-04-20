import * as React from 'react';

export function PartisanEmblem(): React.ReactElement {
  return (
    <svg
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      width="100%"
      height="100%"
      aria-hidden
    >
      <path
        d="M32 8 L52 22 L46 50 L18 50 L12 22 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path
        d="M22 32 L42 32 M32 22 L32 42"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
