# x-bookmark-folder-sorter

Sorts your X (Twitter) bookmarks into your existing bookmark folders, once a day, on a Vercel cron. [Jev](skills/typesafe-ai/SKILL.md) (TypeSafe's System One decision model, called only through Vercel AI Gateway as `typesafe-ai/jev`) classifies each post with a typed `choice` question whose options are your folder names plus `keep_unfiled` and `skip`. Everything else is plain, deterministic code: listing, the confidence gate, idempotency, and the writes.

**It never loses bookmarks.** Dry run is the default. Live mode only *adds* already-bookmarked posts into folders that already exist, using `POST /2/users/:id/bookmarks` with `folder_id`. The X client in this repo has no delete or unbookmark method at all.

## How a run works

1. List your bookmark folders, each folder's post IDs, and your bookmarks (X returns at most the 800 most recent).
2. Choose candidates: unfiled bookmarks first, then filed ones when `CHECK_MISFILED=true`, capped at `MAX_BOOKMARKS_PER_RUN`. Bookmarks in `EXCLUDED_FOLDERS` are left alone.
3. Ask Jev in batches of `JEV_BATCH_SIZE`. Each batch sends one shared, trimmed state (author handle, post text up to `MAX_TEXT_CHARS`, current folder names, and the folder list) plus one `choice` question per bookmark. Criteria keys are the folder names, so they are what the model sees. Every question also offers `keep_unfiled` (no folder clearly fits, so leave it alone) and `skip` (the post can't be judged).
4. Plan each bookmark with the pure planner in `src/sorter/plan.ts`:

| Situation | Result |
| --- | --- |
| Unfiled, a folder chosen, probability and confidence both at least `MIN_CONFIDENCE` (0.7) | `file` |
| A folder chosen below the threshold | `low_confidence` (logged, no write) |
| Already in the chosen folder | `already_in_folder` (no-op, which makes reruns idempotent) |
| `keep_unfiled` or `skip` chosen | nothing happens |
| Filed, a different folder chosen at or above `MISFILED_MIN_CONFIDENCE` (0.9) | `misfiled_report`, or `refile` if `REFILE_MISFILED=true` |
| Jev error, malformed answer, or missing answer | `no_decision` (fails closed) |

5. In live mode only, group the `file` and `refile` actions by folder and send at most 25 IDs per request, capped at `MAX_WRITES_PER_RUN`. Before any write, the runner checks that every ID came from this run's bookmark listing and every folder exists.

Every planned action is logged as one JSON line (`event: "planned"` in dry run, `event: "action"` in live mode). The cron response is a JSON summary.

## Setup

Requires Node 22+.

```bash
npm install
cp .env.example .env   # fill in values
npm run check          # typecheck + unit tests
```

Direct dependencies are pinned to exact versions. The first `npm install` generates `package-lock.json`; commit it so Vercel installs the same dependency tree.

### 1. Jev via Vercel AI Gateway

Jev is called **only** through Vercel AI Gateway, with the same wiring as Jevis: `gateway.evaluationModel('typesafe-ai/jev')` from `@ai-sdk/gateway` and `experimental_evaluate` from `ai`. The client pins the destination to `https://ai-gateway.vercel.sh/v4/ai/evaluation-model`, rejects redirects, routes with `providerOptions.gateway.only: ['typesafe-ai']`, retries once on 429 or 5xx with jitter inside a total `JEV_TIMEOUT_MS` deadline, and fails closed otherwise. It never calls the TypeSafe API or any third-party Jev proxy directly.

- `AI_GATEWAY_API_KEY`: a server-only key from the [AI Gateway API keys page](https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys)
- `JEV_MODEL`: defaults to `typesafe-ai/jev`. Any other value is rejected.

A single flat Choice fits bookmark folders, since X folders have no hierarchy. If your folder list grows into a deep taxonomy, TypeSafe's [hierarchical classification cookbook](https://docs.typesafe.ai/cookbooks/hierarchical_classification.md) (beam search over nested Choice questions) is the pattern to move to.

### 2. X app and OAuth 2.0 user token

The cron calls the X API directly with your own X developer app's OAuth 2.0 credentials, read from Vercel env. Agent-side X connectors (such as a chat bot's X integration) are not available inside the cron.

1. In the [X Developer Console](https://developer.x.com), create an app with OAuth 2.0 enabled. Add the callback URL `http://127.0.0.1:8787/callback` (or set `X_REDIRECT_URI`).
2. Scopes: `tweet.read users.read bookmark.read bookmark.write offline.access`. `offline.access` is what gets you a refresh token for unattended cron runs.
3. Put `X_CLIENT_ID` (plus `X_CLIENT_SECRET` for a confidential client) in `.env`, then run:

```bash
npm run auth:x
```

This opens a local PKCE flow and prints your `X_USER_ID`. If `KV_REST_API_URL` and `KV_REST_API_TOKEN` are in `.env`, it saves the tokens to that store, which is the one the Vercel cron reads. Otherwise it writes the gitignored `.x-tokens.json` for local runs only.

X refresh tokens are single-use and rotate on every refresh, so each new pair is saved back to the store before it is used. On Vercel that store must be persistent: connect **Upstash Redis** from the Vercel Marketplace, which sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`. Use one store per token. If the stored token is ever revoked, re-run `npm run auth:x -- --print-refresh-token` and set the printed value as `X_REFRESH_TOKEN`. The refresher falls back to it automatically.

For a quick local test you can skip all of this and set `X_ACCESS_TOKEN` to a user access token, which expires after about 2 hours.

## Dry run vs live

```bash
npm run sort -- --dry-run     # always dry, regardless of DRY_RUN
npm run sort                  # follows DRY_RUN (default true)
npm run sort -- --live        # explicit live run from your machine
npm run sort -- --dry-run --json > plan.json
```

- **Dry run** (`DRY_RUN` unset, `true`, or anything other than `false`/`0`/`no`): reads from X and asks Jev, then logs the planned folder assignments. It makes no write calls to X.
- **Live** (`DRY_RUN=false`): adds only the `file` actions, plus `refile` actions if `REFILE_MISFILED=true`. It never deletes anything. Low-confidence items are logged and left alone.

Recommended rollout: deploy with `DRY_RUN=true`, read a few days of `planned` logs, tune `FOLDER_DESCRIPTIONS` and `MIN_CONFIDENCE`, then flip to `DRY_RUN=false`.

An X detail to be aware of: X's OpenAPI spec says `folder_id` on `POST /2/users/:id/bookmarks` adds the post to that folder, but it does not say whether this removes the post from its previous folder. That is why re-filing misfiled bookmarks is off by default and reported only.

## Deploy to Vercel

1. Import this repo in Vercel. It uses the "Other" framework preset; `vercel.json` sets the build command, the `public/` output, `maxDuration: 300`, and the cron.
2. Set environment variables for Production. All secrets live only in Vercel env, never in the repo:
   - `CRON_SECRET`: a random string of at least 16 characters, e.g. `openssl rand -hex 32`
   - `AI_GATEWAY_API_KEY`, plus optionally `JEV_MODEL=typesafe-ai/jev` (the default)
   - `X_CLIENT_ID`, `X_CLIENT_SECRET` (if confidential), `X_USER_ID`
   - `KV_REST_API_URL` and `KV_REST_API_TOKEN` (set automatically when you connect Upstash Redis)
   - `X_REFRESH_TOKEN`, only if you did not seed the store with `npm run auth:x`
   - `DRY_RUN=true` to start
3. Deploy. The cron in `vercel.json` runs daily at `0 14 * * *` (14:00 UTC). Crons only run on production deployments.

### Cron auth

Vercel Cron calls `GET /api/cron/sort-bookmarks` with `Authorization: Bearer $CRON_SECRET`. The route compares the header in constant time and returns `401` when it doesn't match. If `CRON_SECRET` is unset, it returns `500` and never runs unauthenticated. To trigger a run manually:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" "https://<your-deployment>/api/cron/sort-bookmarks?dry_run=1"
```

`?dry_run=1` can only force a dry run. There is no query parameter that turns on live mode.

Locally, `npm run dev` serves the same route at `http://127.0.0.1:3000/api/cron/sort-bookmarks`.

## Environment variables

| Name | Default | Purpose |
| --- | --- | --- |
| `CRON_SECRET` | required for the route | Bearer secret Vercel Cron sends |
| `DRY_RUN` | `true` | Only `false`/`0`/`no` enables writes |
| `MIN_CONFIDENCE` | `0.7` | Gate for filing unfiled bookmarks: min(probability of the chosen folder, confidence) |
| `CHECK_MISFILED` | `true` | Re-classify filed bookmarks and report likely misfiles |
| `REFILE_MISFILED` | `false` | Add misfiled bookmarks to the better folder (live only) |
| `MISFILED_MIN_CONFIDENCE` | `0.9` | Gate for misfile reports and refiles |
| `MAX_BOOKMARKS_PER_RUN` | `200` | Cap on Jev classifications per run |
| `MAX_WRITES_PER_RUN` | `50` | Cap on add-to-folder writes per run; the rest are deferred to the next run |
| `AI_GATEWAY_API_KEY` | required | Server-only Vercel AI Gateway key for Jev |
| `JEV_MODEL` | `typesafe-ai/jev` | Must be `typesafe-ai/jev`; anything else is rejected |
| `JEV_BATCH_SIZE` | `10` | Bookmarks per Jev request |
| `JEV_TIMEOUT_MS` | `15000` | Total deadline per Jev batch, including the one retry |
| `MAX_TEXT_CHARS` | `400` | Post text is trimmed to this length before it goes into the Jev state |
| `GATEWAY_ZERO_DATA_RETENTION` | `false` | Request zero data retention from AI Gateway |
| `FOLDER_DESCRIPTIONS` | | JSON object of `{ "Folder name": "what belongs here" }` that sharpens criteria |
| `EXCLUDED_FOLDERS` | | Comma-separated folder names that are never targets and never touched |
| `X_USER_ID` | from `/2/users/me` | Your numeric X user ID |
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | | OAuth 2.0 app credentials for refreshing tokens |
| `X_REFRESH_TOKEN` | | Seed or fallback refresh token |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_*`) | | Persistent store for rotated X tokens |
| `X_TOKEN_STORE_KEY` | `x-bookmark-folder-sorter:x-oauth` | Store key |
| `X_ACCESS_TOKEN` | | Static token for quick local tests |

## Layout

```
api/cron/sort-bookmarks.ts  Vercel function (Web GET handler)
src/handler.ts              cron auth + run + JSON summary
src/sorter/                 questions (Jev state/choice), plan (pure policy), run (orchestration + add-only writes)
src/jev/                    Jev client: Vercel AI Gateway typesafe-ai/jev via the AI SDK (Gateway-only)
src/x/                      X API client (read + add-to-folder only), OAuth2 refresh, token stores
scripts/                    sort CLI, local dev server, OAuth2 PKCE helper
skills/                     vendored TypeSafe agent skill (from Jevis)
tests/                      node:test unit tests using small synthetic mocks
```

## Agent skills

Read [`skills/typesafe-ai/SKILL.md`](skills/typesafe-ai/SKILL.md) before changing the Jev integration (prompts, question shapes, thresholds, Gateway wiring). It is the official [typesafe-ai/skills](https://github.com/typesafe-ai/skills) skill ([MIT](skills/typesafe-ai/LICENSE)), copied from Jevis. The live docs at [docs.typesafe.ai/llms.txt](https://docs.typesafe.ai/llms.txt) are the source of truth. See [`skills/README.md`](skills/README.md) for the Gateway-only rule.
