import type { Config } from 'tailwindcss';

import { diktatPreset } from './src/tailwind-preset.js';

const config: Config = {
  presets: [diktatPreset],
  content: [
    './src/**/*.{ts,tsx,mdx}',
    './src/**/*.stories.@(ts|tsx)',
    './.storybook/**/*.{ts,tsx}',
  ],
};

export default config;
