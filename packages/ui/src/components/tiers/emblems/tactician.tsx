import * as React from 'react';

export function TacticianEmblem(): React.ReactElement {
  return (
    <svg
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      width="100%"
      height="100%"
      aria-hidden
    >
      <polygon
        points="32,8 56,24 48,52 16,52 8,24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <polygon points="32,20 42,28 38,42 26,42 22,28" fill="currentColor" />
    </svg>
  );
}
