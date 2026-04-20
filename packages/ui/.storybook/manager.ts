import { addons } from 'storybook/internal/manager-api';
import { themes } from 'storybook/internal/theming';

addons.setConfig({
  theme: {
    ...themes.dark,
    brandTitle: 'Diktat — Design System',
    brandUrl: 'https://diktat.app',
    colorPrimary: '#7B2CFF',
    colorSecondary: '#6EE7FF',
    appBg: '#0a0a0f',
    appContentBg: '#15151f',
    appBorderColor: '#262633',
    barBg: '#15151f',
    barTextColor: '#cacad6',
    barSelectedColor: '#6EE7FF',
    textColor: '#f2f2f7',
    textInverseColor: '#0a0a0f',
  },
});
