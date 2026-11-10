// Public, build-time feature flags. Read via NEXT_PUBLIC_* envs so the
// value is baked into both the server bundle (RSC) and the client bundle
// (Link hrefs, visibility gates) with no runtime drift. Flags default
// to off: a missing env turns the feature off until the launch team
// explicitly enables it per environment.

export function isOpenDebateEnabled(): boolean {
  return process.env.NEXT_PUBLIC_OPEN_DEBATE_ENABLED === 'true';
}
