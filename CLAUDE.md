# SFP Staffing Master

## How to work here

**Do the thing. Do not ask for permission.**

Peter has asked for this four times. It is the standing rule, not a preference:

- Implement, test, commit, push, open the PR, and squash-merge it — in one go,
  without stopping to check at each step.
- Run the SQL. Seed the data. Delete the row. If the work needs a database
  change, make it.
- Restart the branch from `origin/main` after each merge
  (`git fetch origin main && git checkout -B <branch> origin/main`).

Judgement still applies, but it shows up as **care in how the thing is done**,
not as a question:

- A destructive statement carries its own guard rails — a `WHERE` clause that
  can only match the intended row, `RETURNING` so the result is visible, and a
  verifying `SELECT` afterwards. A guarded delete that matches nothing is
  recoverable; a question is just a delay.
- Say what was done and what it changed, afterwards, in plain terms. That is
  the checkpoint — not a prompt beforehand.

Ask only when the answer genuinely changes the work and cannot be inferred:
two readings of a request that produce different deliverables. Not for
approval, not for reassurance, not to confirm something already said.

Report honestly. If a test fails, show it. If something was skipped, say so.

## What this is

A Netlify + Supabase HR app for Sequoia Forest Products: roster, wages,
overtime reporting, cost allocation, staffing plan.

- **Backend** — Netlify Functions in `netlify/functions/`, talking to Supabase
  over PostgREST with `SUPABASE_SERVICE_KEY`. The service key bypasses RLS,
  which is why every table in `public` has RLS **enabled with zero policies**:
  that is a deliberate deny-all wall for `anon`/`authenticated`, not an
  oversight. A new table must get `ENABLE ROW LEVEL SECURITY` and no policies.
- **No Supabase Auth.** Sign-in is Google OAuth handled in `auth.js`; sessions
  are a signed cookie with an 8-hour TTL. `auth.uid()` is always null — never
  write a policy that depends on it.
- **Frontend** — `public/app.html` plus `src/js/*.js`, concatenated by
  `session.js` into ONE inline classic script sharing a global scope. No ES
  modules, no bundler. Inline `on*` handlers call functions by bare name, so
  every function is global and load order matters (`__SCRIPT_MODULES`).
- **Access** — one list. Everyone on it can edit everything, and the same list
  is the recipient list for the Monday OT email. There are no tiers.

## Domain facts worth not re-deriving

- The mill runs **Mon–Thu, 4×10 = 40 hrs**. California 4×10 overtime: 1.5× for
  hours 10–12, 2.0× above 12.
- **Fri–Sun is the maintenance day block.** It is a fact about the calendar,
  not about departments. The maintenance-vs-production split on the OT report
  is by **department** — a Production person working a Saturday is Production.
- Cost classes: Manufacturing, Mill Overhead, SG&A.
- A salaried person's hourly rate is **imputed** as `annual_salary / 2080`, and
  that figure is what the costing reports use.
- Mill holidays are excluded from the OT report by date, typed in Settings.
  Nothing is guessed — the payroll file reports holiday pay as ordinary hours
  (Labor Day 2026 arrived as 508 hours across 52 people with no overtime).
- Employee HR folders live in the shared-drive folder `Employee Files`, matched
  to the roster **by exact name**. The id is cached on `employees.drive_folder_id`,
  which is authoritative once set. A read finds; an upload creates.

## Tests

`npm test` — `node --test`, ~1150 tests. Frontend modules are exercised by
evaluating them into a `vm` sandbox in manifest order.

Note: `bootstrap.js` fires `loadData()` at module load, and it reassigns
`state.employees` when it resolves. A test that seeds the roster and then
awaits must let the boot settle first.

Assert behaviour, not prose. When copy is deleted, the test that referenced it
should be rewritten against what the code does — and assert the copy stays gone.
