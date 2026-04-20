import * as React from 'react';

export function OperativeEmblem(): React.ReactElement {
  return (
    <svg
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      width="100%"
      height="100%"
      aria-hidden
    >
      <circle cx="32" cy="32" r="20" fill="none" stroke="currentColor" strokeWidth="3" />
      <path
        d="M32 12 L32 18 M32 46 L32 52 M12 32 L18 32 M46 32 L52 32"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <circle cx="32" cy="32" r="6" fill="currentColor" />
    </svg>
  );
}
