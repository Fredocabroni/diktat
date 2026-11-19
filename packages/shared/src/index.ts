export * from './ids.js';
export * from './enums.js';
export * from './errors.js';
// NB: './error-monitor' is intentionally NOT re-exported from the barrel.
// It imports from './alerts' (for `scrubMessage` + `scrubLogPayload`) and
// `@diktat/shared` is in web's next.config transpilePackages — a barrel
// re-export would pull `alerts.ts`'s Telegram-fetch code into any client
// bundle one careless `import { reportError } from '@diktat/shared'` away.
// Server-only consumers import via the explicit subpath:
//   `import { reportError } from '@diktat/shared/error-monitor'`.
// NB: './alerts' is intentionally NOT re-exported from the barrel. It POSTs to
// the Telegram Bot API with the bot token in the URL and must never reach a
// client bundle. `@diktat/shared` is in web's next.config transpilePackages, so
// a barrel re-export would be one careless client import away from bundling the
// token-posting code. Server code imports it via the explicit, greppable
// subpath: `import { makeAlerter } from '@diktat/shared/alerts'`.
