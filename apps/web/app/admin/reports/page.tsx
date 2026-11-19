import { notFound } from 'next/navigation';

import { isOperator } from '../../../lib/operators';
import { getServerSupabaseClient } from '../../../lib/supabase/server';
import { getServiceRoleSupabaseClient } from '../../../lib/supabase/service';
import { dismissReport, hideComment, banFromCommenting } from './actions';

// /admin/reports — operator-only triage surface.
//
// Gate: the authed user id must appear in OPERATOR_USER_IDS. A miss
// returns 404, deliberately indistinguishable from an unknown route so
// the surface is invisible to probes.
//
// The page loads up to 50 open reports via the service-role client
// (public.reports has RLS deny-by-default) and renders three forms per
// row — Dismiss, Hide comment, Ban user. Each posts to a server action
// that re-checks the operator gate before touching the RPC.

export const dynamic = 'force-dynamic';

type ReportRow = {
  id: string;
  target_type: 'debate_arg' | 'drop' | 'user' | 'comment';
  target_id: string;
  reason: string;
  status: string;
  created_at: string;
  reporter_user_id: string | null;
};

export default async function AdminReportsPage() {
  const supabase = await getServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isOperator(user?.id)) notFound();

  const admin = getServiceRoleSupabaseClient();
  const { data, error } = await admin
    .from('reports')
    .select('id, target_type, target_id, reason, status, created_at, reporter_user_id')
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) {
    return (
      <main style={{ padding: 24 }}>
        <h1>Reports</h1>
        <p>Load failed: {error.message}</p>
      </main>
    );
  }

  const rows = (data ?? []) as ReportRow[];
  return (
    <main style={{ padding: 24, maxWidth: 960 }}>
      <h1>Reports</h1>
      <p>{rows.length} open.</p>
      <ul style={{ display: 'grid', gap: 16, listStyle: 'none', padding: 0 }}>
        {rows.map((r) => (
          <li
            key={r.id}
            style={{
              border: '1px solid #ddd',
              borderRadius: 8,
              padding: 12,
              display: 'grid',
              gap: 8,
            }}
          >
            <div style={{ fontFamily: 'monospace', fontSize: 12 }}>
              {r.target_type} / {r.target_id}
            </div>
            <div>{r.reason}</div>
            <div style={{ fontSize: 12, color: '#666' }}>
              {new Date(r.created_at).toISOString()} · reporter {r.reporter_user_id ?? '—'}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <form action={dismissReport}>
                <input type="hidden" name="report_id" value={r.id} />
                <button type="submit">Dismiss</button>
              </form>
              {r.target_type === 'comment' ? (
                <form action={hideComment}>
                  <input type="hidden" name="report_id" value={r.id} />
                  <input type="hidden" name="comment_id" value={r.target_id} />
                  <button type="submit">Hide comment</button>
                </form>
              ) : null}
              {r.target_type === 'user' || r.target_type === 'comment' ? (
                <form action={banFromCommenting}>
                  <input type="hidden" name="report_id" value={r.id} />
                  <input
                    type="hidden"
                    name="target_user_id"
                    value={r.target_type === 'user' ? r.target_id : ''}
                  />
                  <input
                    type="hidden"
                    name="comment_id"
                    value={r.target_type === 'comment' ? r.target_id : ''}
                  />
                  <input
                    name="reason"
                    placeholder="Ban reason"
                    required
                    minLength={1}
                    maxLength={500}
                  />
                  <button type="submit">Ban from commenting</button>
                </form>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
