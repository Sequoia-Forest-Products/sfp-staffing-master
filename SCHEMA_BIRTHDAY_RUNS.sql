-- Birthday run log.
--
-- Applied to production 2026-09-18. Here so the table is reproducible.
--
-- WHY IT EXISTS. Asked why an active employee was not receiving the birthday
-- text, nothing could answer it. The job logs to Netlify and returns, so "did it
-- run", "who was on the list" and "did anything actually leave" were all
-- unanswerable after the fact. One row per run makes all three answerable, and
-- distinguishes the two states that look identical from outside: nobody had a
-- birthday, and the job never ran.
--
-- RLS enabled with NO policies, matching every other table here: the deny-all
-- wall for anon/authenticated. The Netlify functions use the service key, which
-- bypasses it.

CREATE TABLE IF NOT EXISTS public.birthday_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at      timestamptz NOT NULL DEFAULT now(),
  run_date    date        NOT NULL,
  status      text        NOT NULL,   -- sent | partly-sent | delivery-failed | no-birthdays | no-run-day
  people      text[]      NOT NULL DEFAULT '{}',
  recipients  integer     NOT NULL DEFAULT 0,
  attempted   integer     NOT NULL DEFAULT 0,   -- < recipients means the run was cut short
  sent        integer     NOT NULL DEFAULT 0,
  failed      integer     NOT NULL DEFAULT 0,
  detail      text
);

CREATE INDEX IF NOT EXISTS birthday_runs_ran_at_idx ON public.birthday_runs (ran_at DESC);

ALTER TABLE public.birthday_runs ENABLE ROW LEVEL SECURITY;
