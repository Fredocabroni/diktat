// Z-index tokens. Keep ordering deliberate so layered surfaces don't fight.

export const z = {
  base: 0,
  raised: 10,
  dropdown: 1000,
  sticky: 1020,
  overlay: 1030,
  modal: 1040,
  toast: 1050,
  tooltip: 1060,
} as const;

export type Z = typeof z;
