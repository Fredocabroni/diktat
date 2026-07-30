export * from './ids.js';
export * from './enums.js';
export * from './errors.js';
// NB: './alerts' is intentionally NOT re-exported from the barrel. It POSTs to
// the Telegram Bot API with the bot token in the URL and must never reach a
// client bundle. `@diktat/shared` is in web's next.config transpilePackages, so
// a barrel re-export would be one careless client import away from bundling the
// token-posting code. Server code imports it via the explicit, greppable
// subpath: `import { makeAlerter } from '@diktat/shared/alerts'`.
