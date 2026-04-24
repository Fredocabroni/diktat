import type { Config } from 'tailwindcss';

import { diktatPreset } from '@diktat/ui/tailwind-preset';

const config: Config = {
  presets: [diktatPreset],
  // Widened for defense-in-depth after the prod regression where Tailwind's
  // JIT missed a class it should have kept. Include every TS/TSX/MDX/JS file
  // in the app and the shared UI package, plus the UI package's top-level
  // style sheet for `@apply` directives.
  content: [
    './app/**/*.{js,jsx,ts,tsx,mdx}',
    './components/**/*.{js,jsx,ts,tsx,mdx}',
    './lib/**/*.{js,jsx,ts,tsx}',
    '../../packages/ui/src/**/*.{js,jsx,ts,tsx,mdx,css}',
  ],
};

export default config;
