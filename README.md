# NFPL Access Control Service

Decides **who may do what on which job**, explains every answer, shows each person the jobs that need them,
and keeps a history that can answer *"who could have changed this job on the 3rd?"*.

* **Backend:** Node 20 + Express (plain JavaScript), PostgreSQL via raw SQL (`pg`). No ORM, **no cache** (on purpose, see DESIGN.md).
* **Frontend:** React + Vite, thin (5 pages). Identity is simulated with a user switcher.
* **Docs:** [`DESIGN.md`](DESIGN.md) (model, decisions, trade-offs, answers to all 14 questions + 5 extra ones).

---

## 1. Run it

### Fastest: everything in Docker, ONE command
Requirements: **Docker** with Compose v2 (nothing else; no Node, no database install).
```bash
docker compose up -d --build
```
Open **http://localhost** (or `http://<server-ip>` on a server). The first start builds the images, waits for the database, creates the schema and loads the sample data **once** (restarts never wipe anything).

| Task | Command |
|---|---|
| Watch the start-up | `docker compose logs -f backend` |
| Stop (data kept) | `docker compose down` |
| Stop and delete all data | `docker compose down -v` |
| Use another port | put `WEB_PORT=8080` in a `.env` file next to `docker-compose.yml` |
| Use Neon instead of the bundled database | put `DATABASE_URL=<Neon direct string>` in `.env` (see `.env.example`) |
| Run the demo script against Docker | `BASE=http://localhost/api bash demo/demo.sh` |

Three containers run: `db` (PostgreSQL 16), `backend` (the API, **not** published to the host) and `web` (nginx: serves the UI and forwards `/api` to the backend). Only port 80 is exposed.

### Or run it without Docker (development)
Requirements: **Node 20+** and a **PostgreSQL 14+** database. Pick ONE database option.

### Option A: Neon (hosted PostgreSQL)
1. Create a project on neon.tech. In the dashboard click **Connect** and copy the **direct** (not "pooled") connection string.
2. In **Branches**, create a branch called `test` and copy its direct connection string too (tests wipe it).
3. ```bash
   cp backend/.env.example backend/.env      # then paste both strings into backend/.env
   ```

### Option B: a local database in Docker (no account needed)
```bash
docker compose up -d db
cp backend/.env.example backend/.env
# edit backend/.env so that it contains:
# DATABASE_URL=postgresql://nfpl:nfpl@localhost:5432/nfpl
# TEST_DATABASE_URL=postgresql://nfpl:nfpl@localhost:5432/nfpl_test
```

### Then
```bash
npm run install:all     # installs backend, frontend and root dependencies
npm run migrate         # creates the schema          (idempotent)
npm run seed            # loads the sample data       (ONE command; wipes the DB in DATABASE_URL)
npm run dev             # API on :3000, UI on http://localhost:5173
```
Open http://localhost:5173 and use **"Acting as"** (top right) to become any seeded person.
The seed writes ~250 jobs with history, so on a remote database it can take up to a minute.

| Command | What it does |
|---|---|
| `npm run test` | 64 tests against `TEST_DATABASE_URL` (rebuilds that database every run) |
| `npm run seed:scale` | Generates **500 users / 200,000 jobs** and prints timings of the list queries |
| `npm run readme:access` | Prints every person's access in plain language, straight from the data |
| `bash demo/demo.sh` | The 5-minute scripted walkthrough (backend must be running) |
| `npm --prefix backend run bootstrap-admin -- --name "Jane" --email jane@x.com --role access_admin` | The *only* way to create the first Access Admin / Controller |

> Never commit `backend/.env`. `.env.example` is the template.

---

## 2. The sample data (who has what, in plain terms)

5 branches (Mumbai, Delhi, Chennai, Kolkata, Ahmedabad), 10 clients (Acme, Bolt, Cobalt, Delta, Everest, Falcon, Granite, Helix, Indus, Jupiter),
21 users (20 people + a bootstrap actor that only ever appears as "granted by"), 27 grants, ~258 jobs, ~750 audit rows.
Sign-in email for the API is `<first name>@nfpl.test` (e.g. `ravi@nfpl.test`). "All" means no restriction on that dimension.

| Person | Access (role, then client / branch / direction / mode) |
|---|---|
| **Asha Kulkarni** | **Maker** for all clients, all branches, all directions, all modes. **Checker** for client Acme, all branches/directions/modes. **Checker** for client Bolt, all branches/directions/modes. *(a Maker everywhere who is a Checker for only a few clients)* |
| **Ravi Menon** | **Checker** for client Acme, branch Mumbai, direction import, all modes. *(the narrow slice)* |
| **Meera Iyer** | **Maker** for all clients, branch Delhi. **Absent** (from yesterday, 8 days); **Karan** covers for her. *(absent user, with cover)* |
| **Karan Shah** | **Maker** for all clients, branch Chennai. Also covers Meera's delegable roles while she is absent. |
| **Neha Gupta** | **Filer** for all clients, branch Mumbai. |
| **Dev Patel** | **Supervisor** for all clients, branch Mumbai. |
| **Sunita Rao**, **Rajesh Nair** | **Controller** for everything. (Two, so the two-person rule can be shown.) |
| **Vikram Singh** | **Access Admin** for everything. Has no routine job powers. *(the admin)* |
| **Zoya Khan** | **Client Viewer** for client Acme. She is an Acme employee. *(client-side user)* |
| **Kiran Desai** | **Client Viewer** for client Bolt. Also a client-side user. |
| **Overnight Parser** | **System (Parser)** for everything: may create and update jobs only. *(the parser)* |
| **Pooja Reddy** | **Maker** for branch Kolkata. |
| **Suresh Bhat** | **Maker** for branch Ahmedabad. |
| **Imran Qureshi** | **Checker** for branches Chennai, Kolkata and Ahmedabad. |
| **Lata Pillai** | **Checker** for branch Delhi. **Absent** (from yesterday, 15 days) with **nobody covering**. *(absent user, no cover)* |
| **Anita Joshi** | **Filer** for branches Delhi and Ahmedabad. |
| **Farhan Ali** | **Filer** for branches Chennai and Kolkata. |
| **Tina D'Souza** | **Checker** for client Delta (all branches), since 10 days ago. Her **Checker for client Cobalt** grant was valid until 10 days ago, then ended. *(history for the "who could act on the 3rd" question)* |
| **Manoj Verma** | **Supervisor** for branch Kolkata. |

Run `npm run readme:access` to print this from the database (it cannot drift from the data).

**Planted jobs** (ids are stable because the seed creates them first):

| Job id | What it shows |
|---|---|
| 1 | Acme / Mumbai / import, *prepared by Asha*. Asha cannot check it (separation of duties); Ravi can. |
| 2 | Acme / Mumbai / import, *filed*. Use it for cancel-filed / reopen with a second approver. |
| 3 | Acme / Mumbai / export, prepared by Asha: **stuck**, nobody may check it (Ravi is imports-only). |
| 4 | Cobalt / Delhi, owner Meera (absent, **covered** by Karan). |
| 5 | Cobalt / Delhi, owner Lata (absent, **nobody covering**): shows as *unattended*. |
| 6 | Created by the overnight parser. |
| 7 | Cobalt / Kolkata, prepared 16 days ago: *Tina could check it 15 days ago, not today*. |
| 8 | Delta / Mumbai, prepared: Tina (Delta Checker) may check it. |

---

## 3. API (all calls except `/health` and `/dev/*` need `X-User-Id` or `X-User-Email`)

| Area | Endpoint |
|---|---|
| Check + explain | `GET /can?action=job.check&job=1[&user=ID]`, `GET /explain/compare?a=&b=&action=&job=` |
| Worklist | `GET /me/worklist[?assigned=me\|unassigned]`, `GET /me/worklist/count`, `GET /me/unattended`, `GET /me/approvals` |
| Jobs | `GET /jobs`, `GET /jobs/:id`, `GET /jobs/:id/actions`, `POST /jobs`, `PATCH /jobs/:id` |
| Actions | `POST /jobs/:id/actions/job.prepare\|check\|file\|cancel\|cancel_filed\|reopen`, `POST /jobs/:id/reassign`, `POST /jobs/:id/admin-fix` |
| Approvals | `POST /jobs/:id/approvals`, `GET /jobs/:id/approvals`, `POST /approvals/:id/decide` |
| History | `GET /jobs/:id/history`, `GET /jobs/:id/who-could-act?at=ISO[&action=]`, `GET /audit` |
| Manage access | `GET /users`, `GET /users/:id/access`, `POST /grants`, `POST /grants/:id/end`, `POST /users/:id/disable`, `POST /absences`, `POST /absences/:id/end` |
| Roles as data | `GET /roles`, `GET /permissions`, `POST /roles`, `PUT /roles/:id/permissions` |

Errors are `{ "error": { "code", "message", "decision?" } }`. A denial carries the full explanation in `decision`.

---

## 4. Tests (`npm run test`, 64 tests, real PostgreSQL)

| File | Covers |
|---|---|
| `sod-scope` | maker/checker conflict, checker/filer conflict, Asha's and Ravi's scopes, see-vs-act |
| `absence` | absent owner with and without cover, delegate bound by separation of duties, unattended jobs, reassign guard |
| `responsibility` | grant/revoke effective immediately, in-flight jobs, future-dated and back-dated grants, user leaves |
| `dangerous` | cancel a filed job / reopen: Controller + reason + second approver, expiry, single use |
| `admin` | self-grant (code *and* database), forbidden roles, scope widening, conflicting roles, admin-fix limits |
| `parser-client` | parser rights, client-side user (own client only, redacted, read-only) |
| `history` | point-in-time "who could act", job history, compare two people, audit access |
| `worklist-consistency` | the worklist list and count equal exactly the jobs where `can()` is true, for 13 kinds of person |
| `failclosed-audit` | unknown action / broken database deny; append-only audit; grants never rewritten; scope immutable |
| `roles-as-data` | a new role created and used with no code change; guardrails |

---

## 5. Scale (500 users, 200,000 jobs)

`npm run seed:scale` builds the scale case and prints timings. Results from a **local PostgreSQL 16** (page = 50 rows; "db" is `EXPLAIN ANALYZE` execution time):

| Query | broadest Maker | typical staff | Controller | client user |
|---|---|---|---|---|
| Worklist, one page | 0.5 ms db | 0.7 ms db | 65 ms db (0 rows: scans) | 54 ms db (0 rows: scans) |
| Worklist, count | 45 ms db | 45 ms db | 0.1 ms | 0.1 ms |
| Visible jobs, one page | 0.3 ms db | 0.4 ms db | 0.4 ms db | 0.5 ms db |
| Unattended page | - | - | 0.5 ms db | - |

These are database times on a local machine. **Against Neon, add your network round-trip** (tens of ms) to each query, and the first query after
idle may be slower while the compute wakes up. Re-run `npm run seed:scale` against your own database for your numbers.
Scale jobs have no audit history (to keep generation fast); history-based features are demonstrated on the sample data.

---

## 6. Assumptions (the brief is silent, so these are written down)

1. **Identity is simulated.** The caller names themselves with `X-User-Id`/`X-User-Email`. Real login (SSO/JWT) is out of scope; `src/middleware.js` is the one place to replace.
2. **Workflow:** Confirmed → Prepared → Checked → Filed; Cancelled from any pre-filed stage; a filed or cancelled job can be Reopened, which returns to "reopened" and is prepared again. The stage rules are rows in `job_transitions`.
3. **Worklist** = jobs I could perform the *next routine step* on, right now (prepare / check / file). Cancel, reopen, approvals are not "work waiting for me".
4. **Owner** = the person *assigned* to do the next step. It never grants ability (grants decide), and it is cleared whenever the job moves to the next stage.
5. **Separation of duties:** the preparer may not check, and the checker may not file, the same job. (The preparer may file.)
6. **Delegation** covers only roles flagged *delegable* (Maker, Checker, Filer), for the absence window. The absent person's own access is suspended meanwhile.
7. **Controller and Access Admin** can only be created by the bootstrap CLI. An Access Admin cannot hand out Controller or Access Admin, and has no routine job powers.
8. **Dangerous actions** (cancel a filed job, reopen) need: Controller role + a reason + a *different* Controller's approval (valid 24 h, single use).
9. **Admin override** can only send a stuck job *back* to an earlier stage (reason required), never forward and never when filed or cancelled.
10. **Grants and absences cannot be back-dated** through the API. All times are UTC (`timestamptz`, database clock).
11. Asking about a job you cannot see returns **404**, not 403, so a job's existence is not leaked.

## 7. What was cut, and why

| Cut | Why |
|---|---|
| Real authentication, user create/edit API | Not what is being assessed; users are seeded and `bootstrap-admin` exists |
| Detecting jobs that *nobody* could act on (orphans) | Needs a set-based "eligible people per job" query; the stuck job (id 3) is visible via `who-could-act` instead |
| Second-admin approval for admin changes | Replaced by stricter rules: admins cannot hand out Controller/Admin at all |
| Total counts on `/jobs` | Cursor paging keeps it fast; the *worklist* count (the one that matters) exists |
| History for the 200k scale jobs | Generation speed; sample data has full history |
| UI polish | A thin UI is enough to demonstrate the model |

## 8. Project layout
```
backend/   migrations/ (schema + guards)   seed/ (reference.sql, seed.js, scale.js, ...)   src/engine/ (the decision engine)
           src/services/ (writes + audit)  src/routes/   tests/
frontend/  src/pages/ (Worklist, Jobs, JobDetail, Explain, Access, Audit)   src/components/
demo/demo.sh   docker-compose.yml (whole app)   backend/Dockerfile   frontend/Dockerfile + nginx.conf   DESIGN.md
```

## 9. Deploy on AWS (EC2 + Docker)

1. **EC2 -> Launch instance:** Ubuntu 24.04, t3.micro or larger. Security group: **SSH (22) from your IP** and **HTTP (80) from your IP**.
   Login is *simulated* (anyone who opens the site can become the Access Admin), so do **not** open port 80 to the whole internet; terminate the server after your assessment.
2. **Install Docker** on the server:
   ```bash
   curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker ubuntu     # then log out and back in
   ```
3. **Upload and start:**
   ```bash
   scp -i key.pem nfpl-access-control.zip ubuntu@<IP>:~/        # from your PC
   unzip nfpl-access-control.zip && cd nfpl-access
   docker compose up -d --build
   ```
4. Open `http://<IP>/`. Containers restart automatically after a reboot (`restart: unless-stopped`).
5. To use Neon instead of the bundled database, create `.env` next to `docker-compose.yml` with `DATABASE_URL=<Neon direct string>` before step 3.
   Without it, data lives in a Docker volume on the server's disk.
