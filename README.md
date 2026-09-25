# x-bookmark-folder-sorter

Sorts your X (Twitter) bookmarks into your existing bookmark folders, once a day, on a Vercel cron. [Jev](skills/typesafe-ai/SKILL.md) (TypeSafe's System One decision model, called only through Vercel AI Gateway as `typesafe-ai/jev`) classifies each post with a typed `choice` question whose options are your folder names plus `keep_unfiled` and `skip`. Everything else is plain, deterministic code: listing, the confidence gate, idempotency, and the writes.

**It never loses bookmarks.** Dry run is the default. Live mode only *adds* already-bookmarked posts into folders that already exist, using `POST /2/users/:id/bookmarks` with `folder_id`. The X client in this repo has no delete or unbookmark method at all.

## Configuration: secrets in env, everything else in git

Env holds **only credentials**:

| Env var | Purpose |
| --- | --- |
| `CRON_SECRET` | Bearer secret Vercel Cron sends to the route |
| `AI_GATEWAY_API_KEY` | Server-only Vercel AI Gateway key for Jev |
| `X_CLIENT_ID` | Your X app's OAuth 2.0 client id |
| `X_CLIENT_SECRET` | Only for a confidential X client |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Upstash Redis, which holds the rotating X OAuth tokens (set automatically by the Vercel Marketplace integration) |

Every tunable lives in the checked-in [`config/sorter.ts`](config/sorter.ts). Edit it and deploy. It is validated at startup:

| Setting | Default | Meaning |
| --- | --- | --- |
| `dryRun` | `true` | Log planned assignments only. Set `false` to add bookmarks to folders (never deletes). |
| `xUserId` | `''` | Your numeric X user id; empty means look it up via `/2/users/me` each run |
| `minConfidence` | `0.7` | Minimum Jev probability **and** confidence to file an unfiled bookmark |
| `checkMisfiled` | `true` | Re-classify filed bookmarks and report likely misfiles |
| `refileMisfiled` | `false` | Actually add misfiled bookmarks to the better folder (live only) |
| `misfiledMinConfidence` | `0.9` | Stricter gate for misfile reports and refiles |
| `maxBookmarksPerRun` | `200` | Cap on Jev classifications per run |
| `maxWritesPerRun` | `50` | Cap on add-to-folder writes per run; the rest wait for the next run |
| `jevBatchSize` | `10` | Bookmarks per Jev request |
| `maxTextChars` | `400` | Post text is trimmed to this length before it goes into the Jev state |
| `jevTimeoutMs` | `15000` | Total deadline per Jev batch, including the one retry |
| `gatewayZeroDataRetention` | `false` | Ask AI Gateway for zero data retention |
| `folderDescriptions` | `{}` | `{ "Folder name": "what belongs here" }`, which sharpens the Choice criteria |
| `excludedFolders` | `[]` | Folder names that are never targets and never touched |
| `xTokenStoreKey` | `x-bookmark-folder-sorter:x-oauth` | KV key for the X tokens |
| `xRedirectUri` | `http://127.0.0.1:8787/callback` | Callback registered on the X app for `npm run auth:x` |

The Jev model is the constant `typesafe-ai/jev` in `src/jev/client.ts`.

Former env knobs such as `DRY_RUN`, `MIN_CONFIDENCE`, `X_USER_ID`, and `X_REFRESH_TOKEN` are **rejected**: if one is still set in Vercel or `.env`, the run fails with an error naming it. This stops a stale env var from silently changing behavior, for example `DRY_RUN=true` while the config says live. Delete them from Vercel after deploying this version.

## How a run works

1. List your bookmark folders, each folder's post IDs, and your bookmarks (X returns at most the 800 most recent).
2. Choose candidates: unfiled bookmarks first, then filed ones when `checkMisfiled` is on, capped at `maxBookmarksPerRun`. Bookmarks in `excludedFolders` are left alone.
3. Ask Jev in batches of `jevBatchSize`. Each batch sends one shared, trimmed state (author handle, post text, current folder names, and the folder list) plus one `choice` question per bookmark. Criteria keys are the folder names, so they are what the model sees. Every question also offers `keep_unfiled` (no folder clearly fits, so leave it alone) and `skip` (the post can't be judged).
4. Plan each bookmark with the pure planner in `src/sorter/plan.ts`:

| Situation | Result |
| --- | --- |
| Unfiled, a folder chosen, probability and confidence both at least `minConfidence` | `file` |
| A folder chosen below the threshold | `low_confidence` (logged, no write) |
| Already in the chosen folder | `already_in_folder` (no-op, which makes reruns idempotent) |
| `keep_unfiled` or `skip` chosen | nothing happens |
| Filed, a different folder chosen at or above `misfiledMinConfidence` | `misfiled_report`, or `refile` if `refileMisfiled` is on |
| Jev error, malformed answer, or missing answer | `no_decision` (fails closed) |

5. In live mode only, group the `file` and `refile` actions by folder and send at most 25 IDs per request, capped at `maxWritesPerRun`. Before any write, the runner checks that every ID came from this run's bookmark listing and every folder exists.

Every planned action is logged as one JSON line (`event: "planned"` in dry run, `event: "action"` in live mode). The cron response is a JSON summary.

## Setup

Requires Node 22+.

```bash
npm install
cp .env.example .env   # fill in the secrets
npm run check          # typecheck + unit tests
```

Direct dependencies are pinned to exact versions. The first `npm install` generates `package-lock.json`; commit it so Vercel installs the same dependency tree.

### Jev via Vercel AI Gateway

Jev is called **only** through Vercel AI Gateway, with the same wiring as Jevis: `gateway.evaluationModel('typesafe-ai/jev')` from `@ai-sdk/gateway` and `experimental_evaluate` from `ai`. The client pins the destination to `https://ai-gateway.vercel.sh/v4/ai/evaluation-model`, rejects redirects, routes with `providerOptions.gateway.only: ['typesafe-ai']`, retries once on 429 or 5xx with jitter inside the `jevTimeoutMs` deadline, and fails closed otherwise. It never calls the TypeSafe API or any third-party Jev proxy directly.

A single flat Choice fits bookmark folders, since X folders have no hierarchy. If your folder list grows into a deep taxonomy, TypeSafe's [hierarchical classification cookbook](https://docs.typesafe.ai/cookbooks/hierarchical_classification.md) (beam search over nested Choice questions) is the pattern to move to.

### X app and OAuth 2.0 tokens

The cron calls the X API directly with your own X developer app's OAuth 2.0 credentials. Agent-side X connectors (such as a chat bot's X integration) are not available inside the cron.

1. In the [X Developer Console](https://developer.x.com), create an app with OAuth 2.0 enabled and add the callback URL `http://127.0.0.1:8787/callback` (`xRedirectUri` in config).
2. Scopes: `tweet.read users.read bookmark.read bookmark.write offline.access`. `offline.access` is what gets you a refresh token for unattended cron runs.
3. Put `X_CLIENT_ID` (plus `X_CLIENT_SECRET` if confidential) and the Upstash `KV_REST_API_URL`/`KV_REST_API_TOKEN` in `.env`, then run:

```bash
npm run auth:x
```

This runs a local PKCE flow, saves the tokens into the same Upstash store the Vercel cron reads, and prints your X user id, which you can put in `xUserId`. Without the KV vars it writes the gitignored `.x-tokens.json`, which is only for local runs.

X refresh tokens are single-use and rotate on every refresh, so each new pair is saved back to KV before it is used. There is no refresh-token env var. If the stored token is ever revoked, run `npm run auth:x` again.

## Dry run vs live

```bash
npm run sort -- --dry-run     # always dry, regardless of config
npm run sort                  # follows dryRun in config/sorter.ts (default true)
npm run sort -- --live        # explicit live run from your machine
npm run sort -- --dry-run --json > plan.json
```

- **Dry run** (`dryRun: true`): reads from X and asks Jev, then logs the planned folder assignments. It makes no write calls to X.
- **Live** (`dryRun: false`): adds only the `file` actions, plus `refile` actions if `refileMisfiled` is on. It never deletes anything. Low-confidence items are logged and left alone.

Recommended rollout: deploy with `dryRun: true`, read a few days of `planned` logs, tune `folderDescriptions` and `minConfidence`, then commit `dryRun: false`.

An X detail to be aware of: X's OpenAPI spec says `folder_id` on `POST /2/users/:id/bookmarks` adds the post to that folder, but it does not say whether this removes the post from its previous folder. That is why re-filing misfiled bookmarks is off by default and reported only.

## Deploy to Vercel

1. Import this repo in Vercel. It uses the "Other" framework preset; `vercel.json` sets the build command, the `public/` output, `maxDuration: 300`, and the cron.
2. Connect **Upstash Redis** from the Vercel Marketplace, which sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
3. Add the remaining secrets for Production: `CRON_SECRET`, `AI_GATEWAY_API_KEY`, `X_CLIENT_ID`, and `X_CLIENT_SECRET` if confidential.
4. Run `npm run auth:x` locally with the KV vars in `.env` to seed the X tokens.
5. Deploy. The cron in `vercel.json` runs daily at `0 14 * * *` (14:00 UTC). Crons only run on production deployments.

### Cron auth

Vercel Cron calls `GET /api/cron/sort-bookmarks` with `Authorization: Bearer $CRON_SECRET`. The route compares the header in constant time and returns `401` when it doesn't match. If `CRON_SECRET` is unset, it returns `500` and never runs unauthenticated. To trigger a run manually:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" "https://<your-deployment>/api/cron/sort-bookmarks?dry_run=1"
```

`?dry_run=1` can only force a dry run. There is no query parameter that turns on live mode.

Locally, `npm run dev` serves the same route at `http://127.0.0.1:3000/api/cron/sort-bookmarks`.

## Layout

```
config/sorter.ts            all tunables (checked in)
api/cron/sort-bookmarks.ts  Vercel function (Web GET handler)
src/config.ts               secrets from env + config validation + retired-env guard
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
