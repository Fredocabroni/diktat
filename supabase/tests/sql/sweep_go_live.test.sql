-- Behavioural test for migration 20261122000000: the pg_cron job
-- `data_minimization_sweep_daily` is scheduled with a command whose
-- payload is `'dry_run', false` (go-live), not `'dry_run', true`
-- (the shipping-dry-run posture from 20261113000000).
--
--   G1  Exactly one cron.job row exists with jobname
--       'data_minimization_sweep_daily'.
--   G2  Its command text contains the substring "'dry_run', false"
--       and does NOT contain "'dry_run', true".
--   G3  Its schedule is unchanged from 20261113000000 ('0 3 * * *').

begin;

do $$
declare
  v_count    int;
  v_command  text;
  v_schedule text;
begin
  select count(*)
    into v_count
    from cron.job
    where jobname = 'data_minimization_sweep_daily';
  if v_count <> 1 then
    raise exception 'G1: expected exactly 1 cron.job row for data_minimization_sweep_daily, got %',
      v_count;
  end if;

  select command, schedule
    into v_command, v_schedule
    from cron.job
    where jobname = 'data_minimization_sweep_daily';

  if position('''dry_run'', false' in v_command) = 0 then
    raise exception 'G2: cron.job.command for data_minimization_sweep_daily does not contain "''dry_run'', false"; command=%',
      v_command;
  end if;

  if position('''dry_run'', true' in v_command) > 0 then
    raise exception 'G2: cron.job.command for data_minimization_sweep_daily still contains "''dry_run'', true"; command=%',
      v_command;
  end if;

  if v_schedule <> '0 3 * * *' then
    raise exception 'G3: expected schedule ''0 3 * * *'', got %',
      v_schedule;
  end if;
end
$$;

rollback;
