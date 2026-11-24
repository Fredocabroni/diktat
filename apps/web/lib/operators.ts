// Server-only operator allowlist.
//
// OPERATOR_USER_IDS is a comma-separated list of user uuids (public.users.id)
// that may reach /admin/reports. When unset or empty, no one can — the
// admin surface 404s. UUID validation is strict so a typo does not match.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function getOperatorIds(): ReadonlySet<string> {
  const raw = process.env.OPERATOR_USER_IDS ?? '';
  const ids = new Set<string>();
  for (const part of raw.split(',')) {
    const id = part.trim().toLowerCase();
    if (UUID_RE.test(id)) ids.add(id);
  }
  return ids;
}

export function isOperator(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return getOperatorIds().has(userId.toLowerCase());
}
