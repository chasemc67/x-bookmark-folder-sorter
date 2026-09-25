# x-bookmark-folder-sorter

Sorts your X (Twitter) bookmarks into your existing bookmark folders, once a day, on a Vercel cron. [Jev](skills/typesafe-ai/SKILL.md) (TypeSafe's System One decision model, called only through Vercel AI Gateway as `typesafe-ai/jev`) classifies each post with a typed `choice` question whose options are your folder names plus `keep_unfiled` and `skip`. Everything else is plain, deterministic code: listing, the confidence gate, idempotency, and the writes.

**It never loses bookmarks.** Dry run is the default. Live mode only *adds* already-bookmarked posts into folders that already exist, using `POST /2/users/:id/bookmarks` with `folder_id`. The X client in this repo has no delete or unbookmark method at all.

## Configuration: secrets in env, X OAuth in Vercel Connect, everything else in git

Env holds **only credentials**:

| Env var | Purpose |
| --- | --- |
| `CRON_SECRET` | Bearer secret Vercel Cron sends to the route |
| `AI_GATEWAY_API_KEY` | Server-only Vercel AI Gateway key for Jev |
| `VERCEL_OIDC_TOKEN` | Not set by hand. Vercel injects it at runtime; locally `vercel env pull` writes it to `.env.local`. The Connect SDK uses it to authenticate this project. |

The X app's client id and secret, and the X user's refresh token, live in a [Vercel Connect](https://vercel.com/docs/connect) connector, not in env and not in a database. Each run asks Connect for a short-lived X access token (see [X OAuth via Vercel Connect](#x-oauth-via-vercel-connect)).

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
| `xConnectConnector` | `oauth/x-bookmarks` | Vercel Connect connector uid that holds the X OAuth client |
| `xConnectSubjectId` | `chase` | Connect `user` subject whose X grant the cron uses (one subject = one X account) |

The Jev model is the constant `typesafe-ai/jev` in `src/jev/client.ts`.

Env vars this app used to read are **rejected**: if one is still set in Vercel, `.env`, or `.env.local`, the run fails with an error naming it and saying why. That covers the former tunables (`DRY_RUN`, `MIN_CONFIDENCE`, `X_USER_ID`, ...), the old X OAuth vars (`X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_REFRESH_TOKEN`, `X_ACCESS_TOKEN`, `X_TOKEN_STORE_KEY`, `X_REDIRECT_URI`), and the Upstash/KV vars (`KV_URL`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`). This stops a stale env var from silently changing behavior, for example `DRY_RUN=true` while the config says live. Delete them from Vercel before deploying this version (env changes only apply to new deployments).

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

Requires Node 22+ and the [Vercel CLI](https://vercel.com/docs/cli) (`npm i -g vercel`).

```bash
npm install
vercel link            # link this directory to the Vercel project
vercel env pull        # writes .env.local: your project env + a short-lived VERCEL_OIDC_TOKEN
npm run check          # typecheck + unit tests
```

Local scripts load `.env.local` first and then `.env`, so you can also keep `CRON_SECRET` and `AI_GATEWAY_API_KEY` in a hand-written `.env` (see `.env.example`). Vercel Connect always needs the OIDC token from `vercel env pull`; there is no local token-file fallback. The OIDC token is short-lived, so re-run `vercel env pull` when you see an OIDC error.

Direct dependencies are pinned to exact versions. Commit `package-lock.json` so Vercel installs the same dependency tree.

### Jev via Vercel AI Gateway

Jev is called **only** through Vercel AI Gateway, with the same wiring as Jevis: `gateway.evaluationModel('typesafe-ai/jev')` from `@ai-sdk/gateway` and `experimental_evaluate` from `ai`. The client pins the destination to `https://ai-gateway.vercel.sh/v4/ai/evaluation-model`, rejects redirects, routes with `providerOptions.gateway.only: ['typesafe-ai']`, retries once on 429 or 5xx with jitter inside the `jevTimeoutMs` deadline, and fails closed otherwise. It never calls the TypeSafe API or any third-party Jev proxy directly.

A single flat Choice fits bookmark folders, since X folders have no hierarchy. If your folder list grows into a deep taxonomy, TypeSafe's [hierarchical classification cookbook](https://docs.typesafe.ai/cookbooks/hierarchical_classification.md) (beam search over nested Choice questions) is the pattern to move to.

### X OAuth via Vercel Connect

The cron calls the X API directly with a user access token for your account. It gets that token from [Vercel Connect](https://vercel.com/docs/connect): `getTokenResponse('oauth/x-bookmarks', { subject: { type: 'user', id: 'chase' }, scopes })` in `src/x/auth.ts`. Connect stores the X client credentials and your grant, refreshes and rotates X's single-use refresh tokens server-side, and hands the function a short-lived access token. Nothing about X auth is stored in env, Redis, or a local file.

Vercel Connect has no first-party X connector, so this uses a **Custom OAuth** connector (customer-managed: you bring your own X app client id and secret).

1. **Create the X app.** In the [X Developer Console](https://developer.x.com), create an app with OAuth 2.0 user authentication enabled. A confidential ("Web App") client gives you a client id and secret.
2. **Create the Custom OAuth connector.** In the Vercel dashboard, open **Connect** from this project, select **Create Connector**, choose **OAuth**, and enter X's endpoints manually:
   - Authorization endpoint: `https://x.com/i/oauth2/authorize`
   - Token endpoint: `https://api.x.com/2/oauth2/token`
   - Client ID and client secret: from your X app
   - Scopes: `tweet.read users.read bookmark.read bookmark.write offline.access` (`offline.access` is what lets Connect refresh the grant for unattended runs)
   - Grant type: authorization code with PKCE (edit the connector after creating it if you need to select grant types)
   - Connector uid: `oauth/x-bookmarks`, or whatever you choose, as long as it matches `xConnectConnector` in `config/sorter.ts`

   You can also do this with the CLI from this directory: `vercel connect create --help` shows the prompts for a custom OAuth server.
3. **Register Connect's callback on X.** Copy the OAuth callback (redirect) URL that the connector page shows and add it to your X app's callback URLs. X rejects authorizations whose redirect URL isn't registered.
4. **Attach the connector to this project.** A connector created from the project's Connect page is linked automatically. Otherwise run `vercel connect attach oauth/x-bookmarks`, which links Production, Preview, and Development.
5. **Authorize your X account once** for the configured subject (`xConnectSubjectId`, default `chase`):

```bash
vercel env pull        # fresh VERCEL_OIDC_TOKEN
npm run connect:x
```

`connect:x` asks Connect for a token. If the subject has no grant yet, it calls `startAuthorization` and prints the X consent URL. Open it, sign in as the X account the cron should sort, approve, and press Enter. It then prints your numeric X user id, which you can put in `xUserId` to skip the `/2/users/me` lookup each run. The grant belongs to the connector and subject, not to an environment, so authorizing locally also authorizes the production cron. Re-run `npm run connect:x` if you ever revoke the app on X.

If a run finds no valid grant (Connect throws `UserAuthorizationRequiredError` or `NoValidTokenError`), it fails before touching X with `X is not authorized for Connect subject "chase" on connector "oauth/x-bookmarks" ... Run npm run connect:x`. The cron response is a `500` with that message and the log line is `run_failed` with `error: "XAuthorizationRequiredError"`.

**Pricing.** Connect bills per token request (Hobby includes 500 a month; Pro is $3.00 per 1,000). The SDK caches the token in-process and the provider asks for one that stays valid for the whole run, so a daily cron costs about one token request per run.

### Single user now, multi-user later

- **Now (single-user cron):** one Custom OAuth connector and one fixed Connect `user` subject (`xConnectSubjectId: 'chase'`). Chase authorizes once with `npm run connect:x`, and the cron requests tokens for that subject.
- **Later (multi-user product):** the same connector serves any number of X accounts, one Connect `user` subject per end user. A `/connect` page would call `startAuthorization(connector, { subject: { type: 'user', id: <your user id> }, scopes }, { callbackUrl })`, redirect the user to the returned URL, and store the subject-to-user mapping in your own app. The cron would then loop over those subjects and run the same sorter once per subject.

The code is already shaped for that: `ConnectTokenProvider` takes the connector and subject id as parameters (`XConnectTarget`), and only `runFromEnv` reads them from config. `npm run connect:x -- --subject <id>` authorizes any subject, which is handy for trying a second account; the cron today still uses only `xConnectSubjectId`. No multi-user UI or subject storage is built yet.

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
2. Add the secrets for Production: `CRON_SECRET` and `AI_GATEWAY_API_KEY`. The OIDC token Connect uses is injected automatically; no X or KV env vars are needed.
3. Create the Custom OAuth connector, attach it to the project, and run `npm run connect:x` once, as described in [X OAuth via Vercel Connect](#x-oauth-via-vercel-connect).
4. Deploy. The cron in `vercel.json` runs once daily at midnight America/Los_Angeles, scheduled as `0 7 * * *` (07:00 UTC). Vercel cron schedules are UTC-only and do not adjust for daylight saving time: `0 7 * * *` is midnight during Pacific Daylight Time (UTC-7), but during Pacific Standard Time (UTC-8) it fires at 11pm PT instead of midnight unless the cron is changed to `0 8 * * *`. Crons only run on production deployments.

**Upgrading from the Upstash/KV version:** before deploying, remove `X_CLIENT_ID`, `X_CLIENT_SECRET`, and any `X_REFRESH_TOKEN` from the project env, and disconnect the Upstash/KV integration from the project (it only held X tokens; runs fail while its `KV_*` vars are still set). Delete any leftover local `.x-tokens.json`.

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
src/x/                      X API client (read + add-to-folder only), Vercel Connect token provider
scripts/                    sort CLI, local dev server, `connect:x` one-time Connect authorization
skills/                     vendored TypeSafe agent skill (from Jevis)
tests/                      node:test unit tests using small synthetic mocks
```

## Agent skills

Read [`skills/typesafe-ai/SKILL.md`](skills/typesafe-ai/SKILL.md) before changing the Jev integration (prompts, question shapes, thresholds, Gateway wiring). It is the official [typesafe-ai/skills](https://github.com/typesafe-ai/skills) skill ([MIT](skills/typesafe-ai/LICENSE)), copied from Jevis. The live docs at [docs.typesafe.ai/llms.txt](https://docs.typesafe.ai/llms.txt) are the source of truth. See [`skills/README.md`](skills/README.md) for the Gateway-only rule.
