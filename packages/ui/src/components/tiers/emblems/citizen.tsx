import * as React from 'react';

export function CitizenEmblem(): React.ReactElement {
  return (
    <svg
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      width="100%"
      height="100%"
      aria-hidden
    >
      <circle cx="32" cy="32" r="14" fill="none" stroke="currentColor" strokeWidth="3" />
      <circle cx="32" cy="32" r="4" fill="currentColor" />
    </svg>
  );
}
