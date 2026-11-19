'use server';

import { revalidatePath } from 'next/cache';

import { isOperator } from '../../../lib/operators';
import { getServerSupabaseClient } from '../../../lib/supabase/server';
import { getServiceRoleSupabaseClient } from '../../../lib/supabase/service';

// Server-action wrappers around the three operator RPCs
// (admin_dismiss_report / admin_hide_comment / admin_ban_from_commenting).
//
// Each action re-checks the OPERATOR_USER_IDS gate before invoking the
// RPC — the page gate catches the probe, this gate catches a stray form
// post from a non-operator session.

async function requireOperatorId(): Promise<string> {
  const supabase = await getServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isOperator(user?.id)) {
    throw new Error('not_operator');
  }
  return user!.id;
}

function reqUuid(raw: FormDataEntryValue | null): string {
  if (typeof raw !== 'string') throw new Error('bad_input');
  const v = raw.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
    throw new Error('bad_input');
  }
  return v;
}

function optUuid(raw: FormDataEntryValue | null): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return reqUuid(raw);
}

function reqReason(raw: FormDataEntryValue | null): string {
  if (typeof raw !== 'string') throw new Error('bad_input');
  const v = raw.trim();
  if (v.length < 1 || v.length > 500) throw new Error('bad_input');
  return v;
}

export async function dismissReport(formData: FormData): Promise<void> {
  const operatorId = await requireOperatorId();
  const reportId = reqUuid(formData.get('report_id'));
  const admin = getServiceRoleSupabaseClient();
  const { error } = await admin.rpc('admin_dismiss_report', {
    p_operator_id: operatorId,
    p_report_id: reportId,
  });
  if (error) throw new Error(error.message);
  revalidatePath('/admin/reports');
}

export async function hideComment(formData: FormData): Promise<void> {
  const operatorId = await requireOperatorId();
  const reportId = optUuid(formData.get('report_id'));
  const commentId = reqUuid(formData.get('comment_id'));
  const admin = getServiceRoleSupabaseClient();
  const { error } = await admin.rpc('admin_hide_comment', {
    p_operator_id: operatorId,
    p_comment_id: commentId,
    p_report_id: reportId,
  });
  if (error) throw new Error(error.message);
  revalidatePath('/admin/reports');
}

export async function banFromCommenting(formData: FormData): Promise<void> {
  const operatorId = await requireOperatorId();
  const reportId = optUuid(formData.get('report_id'));
  const targetUserId = optUuid(formData.get('target_user_id'));
  const commentId = optUuid(formData.get('comment_id'));
  const reason = reqReason(formData.get('reason'));

  let userIdToBan = targetUserId;
  if (!userIdToBan && commentId) {
    const admin = getServiceRoleSupabaseClient();
    const { data, error } = await admin
      .from('comments')
      .select('user_id')
      .eq('id', commentId)
      .single();
    if (error || !data) throw new Error('comment_not_found');
    userIdToBan = (data as { user_id: string }).user_id;
  }
  if (!userIdToBan) throw new Error('bad_input');

  const admin = getServiceRoleSupabaseClient();
  const { error } = await admin.rpc('admin_ban_from_commenting', {
    p_operator_id: operatorId,
    p_user_id: userIdToBan,
    p_reason: reason,
    p_report_id: reportId,
  });
  if (error) throw new Error(error.message);
  revalidatePath('/admin/reports');
}
