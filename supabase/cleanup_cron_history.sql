-- The telegram-bot cron runs every minute, and pg_cron / pg_net keep a row
-- for every run forever. By Sep 2026 that was ~250k rows / 140 MB of the
-- 152 MB database, adding constant write load to a small instance.
-- Run once in the Supabase SQL editor.

-- 1. Drop run history older than 7 days (only cron bookkeeping, no med data).
delete from cron.job_run_details where end_time < now() - interval '7 days';

-- 2. Keep it trimmed automatically: daily at 03:00 UTC.
select cron.schedule(
  'purge-cron-history',
  '0 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$
);

-- 3. Reclaim the space (run these as separate statements, not in a transaction).
vacuum full cron.job_run_details;
vacuum full net._http_response;
