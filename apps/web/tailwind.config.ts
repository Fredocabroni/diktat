import type { Config } from 'tailwindcss';

import { diktatPreset } from '@diktat/ui/tailwind-preset';

const config: Config = {
  presets: [diktatPreset],
  content: [
    './app/**/*.{ts,tsx,mdx}',
    './components/**/*.{ts,tsx,mdx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
};

export default config;
