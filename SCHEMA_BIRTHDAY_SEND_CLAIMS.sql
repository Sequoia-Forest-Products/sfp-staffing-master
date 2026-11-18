-- Birthday send claims: at most one send per calendar day.
--
-- Applied to production 2026-11-18.
--
-- WHY IT EXISTS. Every birthday day from at least 2026-10-05 to 2026-11-18 left
-- THREE birthday_runs rows 10-20 seconds apart, each one texting the whole
-- roster (~66 x 3 texts). Days with no birthday ran once. A sending run takes
-- ~30s and the invocation was being re-run; nothing in the job knew a send had
-- already happened for that date, so every attempt sent again.
--
-- birthday-lib.js now INSERTs the run_date here before sending. The primary key
-- makes that insert succeed exactly once per date; a second invocation gets a
-- 409, records 'already-sent', and sends nothing.
--
-- To deliberately re-send a day, delete that day's row first.
--
-- RLS enabled with NO policies, matching every other table here.

CREATE TABLE IF NOT EXISTS public.birthday_send_claims (
  run_date    date        PRIMARY KEY,
  claimed_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.birthday_send_claims ENABLE ROW LEVEL SECURITY;

-- Days that already sent are claimed, so no re-invocation can repeat them.
INSERT INTO public.birthday_send_claims (run_date, claimed_at)
SELECT run_date, min(ran_at)
FROM public.birthday_runs
WHERE status IN ('sent', 'partly-sent', 'delivery-failed')
GROUP BY run_date
ON CONFLICT (run_date) DO NOTHING;
