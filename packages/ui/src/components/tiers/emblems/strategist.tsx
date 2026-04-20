import * as React from 'react';

export function StrategistEmblem(): React.ReactElement {
  return (
    <svg
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      width="100%"
      height="100%"
      aria-hidden
    >
      <path d="M16 16 L48 16 L48 48 L16 48 Z" fill="none" stroke="currentColor" strokeWidth="3" />
      <path d="M16 16 L48 48 M48 16 L16 48" stroke="currentColor" strokeWidth="2" opacity="0.5" />
      <circle cx="32" cy="32" r="6" fill="currentColor" />
    </svg>
  );
}
