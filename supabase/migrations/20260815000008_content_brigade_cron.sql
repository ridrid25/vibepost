-- Run the evidence-gated Learning Engine two minutes after each TikTok sync.
do $$
declare
  v_job_id bigint;
begin
  select jobid into v_job_id from cron.job where jobname = 'vibepost-content-brigade';
  if v_job_id is not null then perform cron.unschedule(v_job_id); end if;

  perform cron.schedule(
    'vibepost-content-brigade',
    '2-59/15 * * * *',
    $cron$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets
               where name = 'vibepost_project_url') || '/functions/v1/content-brigade',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Content-Brigade-Secret',
        (select decrypted_secret from vault.decrypted_secrets
          where name = 'vibepost_content_brigade_secret')
      ),
      body := '{"action":"run_cycle"}'::jsonb,
      timeout_milliseconds := 30000
    );
    $cron$
  );
end;
$$;
