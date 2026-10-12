# MemeDay Architecture

**Version 2. Last audited 2026-08-25 against `develop` @ `c921000`.**

Version 1 described a good deal of intended design as though it were built.
This revision separates what the code actually does from what is still a
plan. Anything marked PLANNED has no implementation in the repo today.
Anything marked UNVERIFIED could not be confirmed from source in this repo.

DynamoDB single-table primary store (single-region today; Global Tables
planned), Vercel + Lambda hybrid compute, S3 media behind CloudFront,
Streams-driven materialized views, Cognito identity provider (email +
server-verified wallet sign-in), Bags.fm token launch is a link-out with
server-side read verification (KAN-29); in-app trading (buy/sell/price) is
still mocked (KAN-52).

## Layers

### Frontend : Vercel / v0.app
Next.js, React, Tailwind, shadcn/ui. Wallet connect via the Solana wallet
adapter (`components/WalletProvider.tsx`).

### Compute : hybrid

Vercel serverless (Next.js API routes) handle all synchronous work:

| Route | Purpose |
|-------|---------|
| `/api/auth/email/{signup,confirm,login,forgot-password,reset-password}` | Cognito email auth |
| `/api/auth/wallet/{nonce,verify}` | Wallet challenge + signature verification |
| `/api/users` | User profile upsert |
| `/api/memes` | Finalize a validated pending upload into a feed-visible meme |
| `/api/memes/[id]/vote` | Voting |
| `/api/comments` | Comments |
| `/api/upload-url` | Issue an S3 presigned PUT URL |
| `/api/upload-status/[id]` | Poll a pending upload's validation status |
| `/api/nft-metadata`, `/api/nft-metadata/[id]` | Register and serve NFT metadata JSON |
| `/api/rpc` | Allowlisted Solana JSON-RPC proxy |
| `/api/image/[...key]` | S3 image proxy (see the caveat under Media) |
| `/api/bags/launch-config` | Returns `{ live: false }` off mainnet, or `{ live: true, partnerWallet, partnerConfig }` on it, so the client knows whether to open bags.fm or run the mock |
| `/api/bags/verify` | Verifies a claimed Bags launch (creatorship + partner attribution) on mainnet, or returns a simulated result off it, and stores the outcome either way |
| `/api/bags/my-token` | Returns the caller's verified Bags token, if any — drives launch-button-vs-token-card in the UI |
| `/api/points/me` | Authenticated. Returns the caller's current weekly and all-time points totals (KAN-101) |
| `/api/cron/buffer-motd` | Vercel Cron target (KAN-84). Queues the Meme of the Day to X through Buffer. `CRON_SECRET` bearer auth, not Cognito. See Buffer (X promotion) below |

AWS Lambda handles event-driven and privileged work. Exactly three functions
exist, all defined in `infra/lib/memeday-stack.ts`:

| Lambda | Trigger | Does |
|--------|---------|------|
| `StreamHandler` | DynamoDB Streams (NEW_AND_OLD_IMAGES, batch 100, bisect on error, 3 retries) | Maintains the `FEED#GLOBAL` and `LEADERBOARD#GLOBAL` materialized views; also awards/reverses points and maintains the `LB#DAY#`/`LB#WEEK#`/`LB#ALLTIME` leaderboards (KAN-101, see below) |
| `S3Handler` | S3 `OBJECT_CREATED`, prefix `uploads/` | Validates, sanitizes and re-encodes uploads; then invokes ModerationHandler |
| `ModerationHandler` | Direct async invoke from `S3Handler` (`InvocationType: "Event"`) | Rekognition content moderation |

There is NO EventBridge / cron-triggered Lambda in the stack today. PLANNED.

One scheduled job does exist, but it is a Vercel Cron, not a Lambda (KAN-84):
`vercel.json` declares a single cron, `0 8 * * *` (UTC), that calls
`GET /api/cron/buffer-motd`. Vercel makes that request to the project's
production deployment URL. It needs no CDK, IAM or trigger of its own.

No Lambda performs on-chain signing today. There is no server-side signer in
the repo; every Solana transaction is signed client-side by the user's wallet.
Server-side signing for platform actions is PLANNED.

ModerationHandler has no S3 subscription of its own: S3 rejects two
overlapping `OBJECT_CREATED` + prefix subscriptions as ambiguous. S3Handler
invoking it directly also guarantees moderation runs on the final,
re-encoded asset rather than the raw upload.

### Data : Amazon DynamoDB (single-table primary store)
One table per stage, `MemeDayProd` and `MemeDayDev` (NOT `MemeDay`; the prod
table was renamed to create all three GSIs in one deploy, and the original
`MemeDay` table is retained as the rollback artifact). Single-region.
Global Tables are PLANNED but not deployed; the single-table design is built
to drop into them without remodeling. Streams enabled. PAY_PER_REQUEST.

TTL is enabled on the attribute `expiresAt`. Only `PENDING#` and `RATE#`
items are ever written with it, so memes, users and comments are never
touched by TTL.

### Media : Amazon S3 + CloudFront
- S3 is a private bucket (`BLOCK_ALL` public access) holding meme images.
  NFT metadata JSON is served from DynamoDB via `/api/nft-metadata/[id]`
  when `NFT_STORAGE_PROVIDER=s3`, not from S3. When it is `irys`, the client
  uploads the metadata JSON straight to Arweave via Irys instead (KAN-10);
  no `NftMetadata` row is written and that route is never called for those
  mints.
- CloudFront (Origin Access Control) is the public read path, one
  distribution per stack.
- Clients upload directly to S3 via presigned PUT URLs, bypassing Vercel.
  Bucket CORS allows `PUT` from any origin.
- A Next.js image proxy (`/api/image/[...key]`) exists and is selected by
  `cfUrl()` in `lib/db.ts` whenever `CLOUDFRONT_DOMAIN` is unset. **It cannot
  work in a deployed environment**: the Vercel runtime IAM user deliberately
  does not have `s3:GetObject` (KAN-38 decided to accept a 500 on that path
  rather than keep the grant). Treat it as a local-development affordance,
  not a production fallback. Do not remove the route without also changing
  `cfUrl()`.

### Auth : Amazon Cognito (identity provider)
- Cognito is the only identity system. `userId` is the Cognito `sub`.
- Sign-up requires at least one of email OR wallet (either alone is valid);
  the other can be linked later. The pool enforces this: `email` is
  `required: false`, sign-in aliases are username + email, and wallet users
  get the opaque username `wallet_<walletAddress>`.
- Enabled auth flows are `adminUserPassword` (wallet login), `userSrp`
  (email/password), and `refreshTokenAuth` (session renewal — CDK adds
  `ALLOW_REFRESH_TOKEN_AUTH` to every client by default).
- Email login is standard Cognito. The route resolves an email to a username
  with `ListUsers`, not via a DynamoDB index.
- Wallet login (`app/api/auth/wallet/`):
  1. `/nonce` issues a challenge `<timestampMs>:<walletAddress>:<random>.<hmac>`,
     HMAC-SHA256 over the nonce with `WALLET_AUTH_SECRET`.
  2. The client signs the challenge string with the wallet.
  3. `/verify` re-derives the HMAC, enforces a 5-minute TTL, checks the
     embedded wallet address, then verifies the ed25519 signature. It accepts
     the raw message plus four Solana off-chain message envelope variants,
     because Ledger devices refuse to sign raw bytes.
  4. On first sight of a wallet it creates the Cognito user with a
     deterministic server-derived password
     (`HMAC(WALLET_AUTH_SECRET, "pwd:" + address)` base64url, plus an `Aa1!`
     suffix to satisfy the pool password policy) and suppresses the welcome
     email.
  5. It then issues the session with `AdminInitiateAuth` /
     `ADMIN_USER_PASSWORD_AUTH` and returns the access token, plus an
     `isNewUser` flag so the client can distinguish a first sign-up from a
     return login.
- This is NOT a Cognito custom-auth (`CUSTOM_AUTH`) challenge flow. There are
  no Define/Create/VerifyAuthChallenge Lambda triggers. The signature check
  happens in the API route. Cognito is still the only identity provider and
  the only issuer of sessions.
- API routes authenticate the caller by verifying the Cognito **access**
  token with `aws-jwt-verify` (`lib/cognito.ts`) and taking `payload.sub`.
- Session lifetime uses Cognito's own two-token model. The access token is
  short-lived (pool default, 60 min) and lives in `localStorage`; the refresh
  token lives 30 days in an httpOnly `md_rt` cookie scoped to `/api/auth`, so
  page JS can never read it. `/api/auth/refresh` trades that cookie for a new
  access token via `AdminInitiateAuth` with `AuthFlow: REFRESH_TOKEN_AUTH`.
  `/api/auth/logout` clears the cookie.
- A stored access token is never trusted because it exists — only because its
  `exp` is still in the future. `lib/session.ts` `getAccessToken()` is the only
  supported way to obtain a token for an API call; it renews first if the
  stored one is stale. `components/SessionSync.tsx` runs the same check once
  per page load so the UI's signed-in state reflects a session that actually
  works. Checking a token's presence instead of its expiry is what let the app
  render as connected on top of a dead session.
- Consequence: a returning user is renewed silently. The wallet is not asked to
  re-sign the nonce on refresh or on a return visit within the refresh token's
  30 days; re-signing happens only when that token is gone or rejected.
- There is no separate or parallel wallet/JWT session system alongside
  Cognito. The refresh cookie is transport for a Cognito-issued token, not a
  second session mechanism.
- `upsertUser` writes sparse `EMAIL#` (GSI1) and `WALLET#` (GSI2) index keys.
  Only the `WALLET#` one is currently read by any query. See GSI notes below.

### On-chain : Solana

#### Network selection and kill switch
`lib/solana/network.ts` is the single choke point. Nothing else may read
`SOLANA_*` or hardcode a cluster.
- `SOLANA_NETWORK` must be exactly `devnet` or `mainnet`; anything else
  throws at import.
- `mainnet` additionally requires `VERCEL_ENV=production`. Preview, local and
  CI reject a mainnet request outright rather than downgrading it silently.
- A mismatch guard rejects `SOLANA_NETWORK=devnet` with a mainnet-looking
  `SOLANA_RPC_URL` and vice versa, matched on provider hostname conventions.
  A custom hostname naming neither cluster passes through unchecked.
- `SOLANA_ENABLED` (`"true"` / `"false"`) is an explicit kill switch that
  calling code short-circuits on, with `SOLANA_DISABLED_MESSAGE` for the UI.

#### What is live vs mocked
- NFT mints: LIVE, `lib/nft.ts`, Metaplex Core (`mpl-core`) via umi `create`.
  Single asset account (no SPL mint/ATA/metadata/edition accounts), so mint
  rent is a fraction of classic Token Metadata. Royalties plugin at 250 bps
  (100% to the minting wallet), `ImmutableMetadata` plugin in place of the
  old `isMutable: false`. No on-chain `symbol` field in Core; `MDAY` is no
  longer set anywhere. Signed client-side by the user's wallet.
- Solana Pay tips: LIVE, `lib/solana/tip.ts`.
- Bags.fm token launch (KAN-29): LIVE as a link-out, production only. A
  single server-side switch, `isBagsLiveModeEnabled()` in
  `lib/bags-server.ts` (`SOLANA_ENABLED && SOLANA_NETWORK === "mainnet"`,
  read from `lib/solana/network.ts` — never a second, independently-computed
  copy of this condition anywhere else), decides live vs mock for every Bags
  call site. Live: MemeDay builds a Launch Intent URL (`lib/bags.ts`, pure,
  no secrets) carrying our partner wallet + Partner Config PDA and opens it
  in a new tab; the creator connects and signs on bags.fm itself. MemeDay
  signs nothing and calls no on-chain RPC for creatorship. `POST
  /api/bags/verify` reads Bags' `token-launch/creator/v3` HTTP endpoint
  (`x-api-key`, server-only) to confirm creatorship, then reads the launch's
  on-chain `FeeShareConfig` account (fee-share-v2 program
  `FEE2tBhCKAt7shrod19QttSVREUYPiyMzoku1mL1gqVK`, PDA seeded on
  `["fee_share_config", base_mint, quote_mint]`) via `Connection.getAccountInfo`
  to confirm attribution — this is a read, no SOL spent. The launch
  transaction's `accountKeys` (Bags' `token-launch` HTTP endpoint) is not a
  valid attribution signal: KAN-73's check on it always read false for a real
  creator launch, since Bags stores the partner in `FeeShareConfig`, created
  in its own transaction before the launch, never referenced by it. Off mainnet
  (Preview, local, CI): no bags.fm tab opens and no call reaches
  `public-api-v2.bags.fm` — the launch button runs a labeled simulated path
  straight to a stored, obviously-fake `SIMULATED_<symbol>` token, so the
  flow stays reviewable. `BAGS_API_KEY`/`BAGS_PARTNER_WALLET`/
  `BAGS_PARTNER_CONFIG` are read and validated lazily, only inside the live
  branch — never at import, since Preview/local/CI deliberately never set
  them. The verify route itself has no mainnet gate of its own: off mainnet
  it just takes the simulated branch instead of calling Bags, and either way
  it spends nothing.
- One creator token per user is a UI-only rule (KAN-29 follow-up): a
  verified `TOKEN#` record (`lib/db.ts` `getVerifiedBagsToken`) makes
  `components/BagsLaunchClaim.tsx` render `components/BagsTokenCard.tsx`
  instead of the launch button. Not enforced in `POST /api/bags/verify` or
  the DB — a second real launch by the same user would still verify and
  overwrite/add a `TOKEN#` item if attempted outside the UI.
- Bags.fm in-app trading (buy/sell/price, KAN-52): still MOCKED
  (`lib/bags.ts` `buyCreatorToken`/`sellCreatorToken`/`getBagsTokenPrice`,
  simulated delays, no network calls). `components/InvestModal.tsx` still
  shows simulated prices — this has not been touched by KAN-29.

#### RPC access
All browser RPC traffic goes through `/api/rpc` (`app/api/rpc/route.ts`),
never straight to the provider. A paid provider endpoint carries its API key
in the URL, and anything handed to a client component ships in the page the
browser downloads, so `SOLANA_RPC_URL` is server-only and the client is given
`SOLANA_CLIENT_RPC_PATH` (`/api/rpc`) instead, resolved against
`window.location.origin` in `components/WalletProvider.tsx`.

The proxy forwards only an allowlist of JSON-RPC methods
(`lib/solana/rpc-allowlist.ts`); without that it would be a free
general-purpose RPC billed to us. A batch is rejected whole if any member is
off-allowlist. Adding an on-chain feature that needs a new method means
adding it there. Deliberately excluded: `getProgramAccounts`,
`getSignaturesForAddress`, `getBlock*`, and the DAS endpoints.
`getTransaction` and `getRecentPrioritizationFees` are allowed because the
Irys storage top-up needs them (priority fee lookup and landing
confirmation); the per-IP rpc rate limit still applies to both.

Consequence: the proxy is HTTPS-only, so the WebSocket `signatureSubscribe`
that `Connection.confirmTransaction` normally waits on is unavailable. Both
the tip and mint paths confirm by polling `getSignatureStatuses` instead
(`lib/solana/confirm.ts`); `lib/nft.ts` overrides umi's `confirmTransaction`
for the same reason. Any new send-and-confirm path must do the same.

## Single-table data model

Base table `MemeDayProd` / `MemeDayDev`. `PK` = partition key, `SK` = sort
key. All entities are modeled as item types on one table. Rows sharing
`PK = MEME#<memeId>` form one item collection (a meme's metadata, comments
and likes) retrievable in a single query.

### Implemented entities

| Entity | PK | SK | Key attributes |
|--------|----|----|----------------|
| User | `USER#<userId>` | `USER#<userId>` | `userId`, `email?`, `walletAddr?`, `displayName?`, `authMethods`, `bagsProjectId?`, `creatorTokenAddr?`, `creatorTokenSymbol?`, `credScore`, `createdAt` (userId = Cognito sub; need >=1 of email/wallet) |
| Meme | `MEME#<memeId>` | `MEME#<memeId>` | `memeId`, `creatorId`*, `ownerId`+, `creatorWalletAddr?`, `s3Key`, `caption`, `nftMint?`, `status`, `likeCount`, `commentCount`, `score`, `listingPrice?`, `createdAt` |
| Comment | `MEME#<memeId>` | `COMMENT#<createdAt>#<commentId>` | `commentId`, `memeId`, `userId`, `walletAddr?`, `body`, `createdAt` |
| Like | `MEME#<memeId>` | `LIKE#<userId>` | `createdAt` (one item per user = dedupe) |
| PendingUpload | `PENDING#<pendingId>` | `PENDING#<pendingId>` | `pendingId`, `creatorId`, `s3Key`, `caption`, `status`, `reason?`, `createdAt`, `expiresAt` (TTL, 24h) |
| NftMetadata | `NFTMETA#<id>` | `NFTMETA#<id>` | `nftMetaId`, `name`, `image_url`, `description`, `createdAt` |
| BagsToken (KAN-29) | `USER#<creatorId>` | `TOKEN#<memeId>` | `memeId`, `tokenMint`, `symbol`\*\*, `name`\*\*, `partnerAttribution`, `verifiedAt`. Shares the User item's PK by design. Legacy rows exist at SK `TOKEN#PRIMARY` and `TOKEN#<mint>` with a boolean `partnerAttributed`; read back with `memeId` `""` and still shown on the profile |
| RateLimit counter | `RATE#<identity>` | `<limitKey>#<windowStart>` | `requestCount`, `expiresAt` (TTL, window + 60s) |
| Feed item | `FEED#GLOBAL` | `<score padded to 15 digits>#<memeId>` | snapshot: `memeId`, `creatorId`, `s3Key`, `caption`, `score`, plus `GSI3PK`/`GSI3SK`. Written only by StreamHandler |
| Leaderboard | `LEADERBOARD#GLOBAL` | `USER#<creatorId>` | `creatorId`, `memeCount`, incremented/decremented by StreamHandler |
| Points award (KAN-101) | `POINTS#<earnerId>` | `AWARD#<ACTION>#<keys>` | `points`, `action`, `sourceId`, `week` (ISO week UTC of the source item's `createdAt`), `createdAt`, `qualifyingMemeId?` (referrals only). ACTION ∈ UPLOAD/RECEIVE_LIKE/GIVE_LIKE/GIVE_COMMENT/RECEIVE_COMMENT/REFERRAL. No TTL — a permanent ledger. Written only by StreamHandler, one `attribute_not_exists(PK)` Put per award, so a replayed Streams record can never double-award |
| Referral marker (KAN-101) | `POINTS#<referredUserId>` | `REFERREDBY` | `referrerId`, `createdAt`. Written by StreamHandler off a USER# item's `referredBy` attribute appearing (INSERT or MODIFY, whichever carries it first — see Points & Leaderboard below) |
| Points daily counter (KAN-101) | `POINTS#<userId>` | `DAY#<yyyy-mm-dd>#<ACTION>` | `used` (points or count, depending on the action's cap unit — see `lib/points-config.ts`), TTL `expiresAt` (2 days). Enforces each action's daily cap; the day is the SOURCE item's UTC date, not "now" |
| Points period total (KAN-101) | `LB#DAY#<yyyy-mm-dd>` / `LB#WEEK#<isoYear>-W<ww>` / `LB#ALLTIME` | `USER#<userId>` | `points`, `userId`, plus `GSI3PK = PK` and `GSI3SK = <points padded to 15 digits>#<userId>` — GSI3 is already overloaded for `FEED#GLOBAL` (see below), these are three more GSI3PK values on the same index. `LB#DAY#` items carry a TTL (8 days) since they're only ever queried for "today"; `LB#WEEK#`/`LB#ALLTIME` do not |

\* `creatorId` is fixed.  + `ownerId` is currently always equal to
`creatorId`; nothing changes it yet (see NFT resale below).  \*\* `symbol`/
`name` on BagsToken are as supplied by the creator when they claim the
launch, not independently verified against Bags — neither of Bags' two GET
endpoints returns a token name or symbol. `tokenMint` and `partnerAttribution`
are the verified fields.

Meme `status` values in code: `active`, `listed` (set when `listingPrice` is
present at finalize), `pending_review` (set by ModerationHandler). Items
predating KAN-44 may have no `status` at all, which is treated as
feed-eligible.

`score` is currently only ever incremented in lockstep with `likeCount` by
`voteMeme`, so today `score == likeCount`. It is a separate attribute so a
richer ranking can be introduced without a migration.

### PLANNED entities (described in v1, no implementation exists)

| Entity | PK | SK | Status |
|--------|----|----|--------|
| Ownership | `MEME#<memeId>` | `OWNERSHIP#<ts>#<txSig>` | PLANNED. Zero occurrences in the codebase |
| Listing | `MEME#<memeId>` | `LISTING#ACTIVE` | PLANNED. Zero occurrences. The current placeholder is a `listingPrice` attribute on the `MEME#` item itself |

### Global secondary indexes (overloaded)

All three are declared identically in CDK: generic `GSI<n>PK` / `GSI<n>SK`
string key pairs with the default (ALL) projection. What they mean is a
convention held in application code, not in the table definition.

| Index | GSI PK | GSI SK | Written by | Read by |
|-------|--------|--------|-----------|---------|
| GSI1 | `USER#<creatorId>` | `MEME#<createdAt>` | `createMeme` | `getMemesByCreator` (creator profile) |
| GSI1 (sparse) | `EMAIL#<email>` | `USER#<userId>` | `upsertUser` | Nothing today. Email login resolves through Cognito `ListUsers` instead. Kept because it is the cheap path if that changes |
| GSI2 | `OWNER#<ownerId>` | `MEME#<createdAt>` | `createMeme` | Nothing today. Intended for "memes a user owns" once resale exists |
| GSI2 (sparse) | `WALLET#<addr>` | `USER#<userId>` | `upsertUser` | `getUserByWallet` |
| GSI3 | `FEED#GLOBAL` | `<createdAt>` | StreamHandler, on feed items | `getMemes` (newest-first global feed); `getFeedPage` (KAN-86: range-filtered via `GSI3SK >= cutoff`, paginated, backs `/browse`) |
| GSI3 (further overloaded) | `LB#DAY#<date>` / `LB#WEEK#<isoYear>-W<ww>` / `LB#ALLTIME` | `<points padded to 15 digits>#<userId>` | StreamHandler (KAN-101 `awardPoints`/`reverseAward`) | `getPointsLeaderboard` (top 50 by points, `ScanIndexForward: false`) |

GSI3 `MARKET#LISTED` sorted by zero-padded `priceSol`, described in v1, is
PLANNED. Nothing writes or reads it.

There is no index on `LIKE#` items. The v1 claim that GSI1 maps `USER#` to a
user's likes is not implemented.

### Served on the base table (no GSI)
- Comments: `PK = MEME#<id>`, `SK begins_with COMMENT#`
- Verified Bags tokens for a creator: `PK = USER#<creatorId>`,
  `SK begins_with TOKEN#` (KAN-29)
- "Did user like?": `GetItem` on `LIKE#<userId>`
- Meme of the day: `Query PK = FEED#GLOBAL`, `ScanIndexForward: false`,
  `Limit: 1`. This is why the feed item SK zero-pads the score to 15 digits:
  it makes DynamoDB's lexicographic sort equal a numeric sort. Distinct from
  Browse's range-filtered, paginated read (`getFeedPage`, KAN-86), which
  queries GSI3 by `GSI3SK` (chronological), never this base-table path.
- Leaderboard: `Query PK = LEADERBOARD#GLOBAL`
- Sale history (`SK begins_with OWNERSHIP#`): PLANNED, see above.

`getAllUsers` in `lib/db.ts` uses a `Scan`. It has zero callers, and the
runtime IAM user is deliberately not granted `dynamodb:Scan`, so calling it
in a deployed environment would fail with AccessDenied.

### NFT resale : ownership transfer and pricing (PLANNED)
None of this is implemented. It is recorded here as the intended design, not
as a description of current behavior.
- `ownerId` should be mutable and changed only by the current owner, via
  `UpdateItem` with `ConditionExpression ownerId = :caller`, so non-owners
  (including the original creator) fail at the DB.
- For-sale browsing should use GSI3 `MARKET#LISTED` sorted by price, with
  `priceSol` zero-padded in the SK so ordering is correct.
- A sale should be a single `TransactWriteItems`: write the
  `OWNERSHIP#<ts>` record, re-point the meme's `ownerId` and GSI2 PK to
  `OWNER#<buyer>`, and clear the active listing, so a price change cannot be
  raced. The on-chain Metaplex transfer is reconciled after confirmation.

## Upload, validation and moderation pipeline

1. `GET /api/upload-url` authenticates the caller, applies the
   `uploadPerUser` and `uploadPerIp` limits, writes a `PENDING#<id>` item
   with status `pending_upload`, and returns a 5-minute presigned PUT URL for
   `uploads/<userId>/<pendingId>.<ext>`.
2. The client PUTs the file straight to S3.
3. `S3Handler` fires on `OBJECT_CREATED` under `uploads/`. It:
   - rejects GIF and WEBP explicitly, because Rekognition's
     `DetectModerationLabels` only supports JPEG/PNG so they cannot be
     screened (temporary, KAN-48);
   - rejects any extension other than jpg/jpeg/png;
   - rejects files over 5 MB;
   - sniffs the real format with sharp and rejects a mismatch against the
     claimed extension (disguised file);
   - rejects images whose long edge is under 400px or short edge is under
     150px, or whose long edge exceeds 4096px;
   - strips EXIF by re-encoding with sharp and writes the cleaned file back
     to the same key with object metadata `validated=true`, which is also the
     guard against the resulting `OBJECT_CREATED` re-triggering this Lambda;
   - marks the pending record `screening`, or `rejected` with a reason and
     deletes the object. S3Handler never sets `active`.
   An upload whose `PENDING#` record is missing is treated as an orphan and
   the object is deleted.
4. `S3Handler` then invokes `ModerationHandler` asynchronously
   (`InvocationType: "Event"`). If the invoke fails, S3Handler rejects the
   upload ("We couldn't screen this image") and deletes the object, so it
   never sits in `screening` forever.
5. `ModerationHandler` calls Rekognition `DetectModerationLabels` with
   `MinConfidence: 50`, then blocks if any returned label is in its explicit
   block list (explicit nudity, graphic violence, weapons, hate symbols) at
   confidence >= 80. The API-level minimum and the block threshold are
   deliberately different numbers. It is FAIL-CLOSED: a Rekognition error
   rejects the upload with a retry message.
6. Outcomes:
   - clean: `PENDING#` `screening` → `active`, conditional on the record still
     being `screening`, so a clean result never revives a rejected or expired
     upload. This is the only place `active` is set.
   - block, `PENDING#` exists: status `rejected` with a generic reason.
   - block, the `MEME#` item exists: status `pending_review`. Backstop only;
     finalize requires `active`, so a meme cannot exist before screening.
   - block, neither: logged as `blocked_orphan`.
7. `POST /api/memes` refuses to finalize unless the pending record is
   `status: "active"` and owned by the caller (`425` if still validating or
   screening, `422` if rejected). `resolveAsset` (`lib/mint-service.ts`)
   applies the same gate to every mint, and the client polls
   `/api/upload-status` until `active` before it starts any paid wallet prompt
   (Irys storage funding included). It reads the creator's wallet address at
   finalize time, not at presign time, because the client upserts its profile
   in between.

`pending_review` memes are excluded everywhere: `getMemeById` returns null,
`getMemesByCreator` filters them, and StreamHandler both refuses to add them
to `FEED#GLOBAL` and pulls them back out (undoing the leaderboard increment)
if they are flagged after publishing.

Note a known inconsistency: `app/api/upload-url` still lists `gif` and `webp`
in its allowed extensions, so a presigned URL is issued for a file that
`S3Handler` will then reject and delete. The rejection is correct, but the
round trip is wasted and it consumes an upload rate-limit slot.

## Rate limiting (KAN-19)

`lib/rate-limit-config.ts` is the single source of truth for every limit.
Nothing else may hardcode a max or window. Current limits are starting
values, not measured thresholds.

- Per user, per day: 10 uploads, 200 votes, 50 comments.
- Per IP Sybil ceilings, per day: 60 uploads, 300 comments. These are not
  per-person limits. An IP is shared by carrier NAT, offices and VPN exits,
  so they are deliberately loose.
- Per IP on unauthenticated routes: 60 rpc/min, 10 logins/15min,
  5 signups/hour, 3 forgot-password/hour, 10 reset-password/hour,
  10 confirm/hour, 20 wallet-nonce/15min, 20 wallet-verify/15min.
- Bags launch verification (KAN-29), per day: 10/user, 20/IP.

Mechanics (`lib/rate-limit.ts`):
- FIXED WINDOW, not sliding or token bucket. A caller can burst up to ~2x at
  a window boundary. This guards a cost budget, not a billing meter, so that
  is a deliberate tradeoff against complexity.
- One atomic DynamoDB `ADD` per check, against `RATE#<identity>` /
  `<limitKey>#<windowStart>`, with TTL set to window end plus 60s.
- FAIL-OPEN. A failed counter write logs and lets the request through. A
  DynamoDB hiccup must never be the reason a real user gets a 429.
- Client IP comes from `x-forwarded-for`, which on Vercel is set by its own
  edge from the real TCP connection. The multi-entry warning in `getClientIp`
  is a canary for a CDN being placed in front of Vercel, which would make the
  first entry client-supplied and spoofable. Do not delete it as dead code.
- Identities are salted-hashed (with `WALLET_AUTH_SECRET`) before logging.
  Raw IPs and Cognito subs are personal data; the deployment runs from the EU.
- The 429 body is identical on every route, so it cannot be used as a tuning
  oracle or an account-existence oracle.

## Points & leaderboard (KAN-101)

`lib/points-config.ts` is the single source of truth for point values and
daily caps — nothing else may hardcode either. Separate from
`lib/rate-limit-config.ts`: these bound how much a user can earn per day, not
how many requests they can make.

- Actions and points: upload 10 (cap 3 uploads/day), receive like 2 (cap 100
  pts/day), give like 1 (cap 20 pts/day), give comment 3 (body ≥ 10 chars, one
  award per meme per user, cap 10/day), receive comment 1 (cap 50 pts/day),
  referral 20 (cap 3/day). A cap is a ceiling on the whole award, never
  partial — an award that would push a day's total over its cap is rejected
  outright, not truncated.
- No points for a self-like, self-comment, or self-referral. Likes and
  comments on a meme whose status is `pending_review` or `removed` earn
  nothing for either side.
- All awards and reversals happen in `lambdas/stream-handler/index.ts` only,
  off DynamoDB Streams (`LIKE#`, `COMMENT#`, `MEME#`, and `USER#` records) —
  never computed live and never touched by any API route.
- One `TransactWriteItems` per award: the ledger row (`attribute_not_exists`,
  so a replayed Streams record never double-awards), the day counter (capped
  by a `ConditionExpression`), and an `ADD` to the day/week/all-time period
  totals. On cancellation, `awardPoints` inspects `CancellationReasons`: if
  every reason is `None`/`ConditionalCheckFailed`, the award already exists or
  the day's cap is hit — an expected outcome, not an error, no retry. Any
  other reason (`TransactionConflict` from a genuinely concurrent writer on
  the same period-total item, throttling, ...) retries up to 3 attempts with
  short jittered backoff before giving up; only then does it propagate to
  `safePointsOp`, which logs and emits `PointsAwardFailure`. A separate,
  always-run step then re-reads each period total's `points` and `SET`s
  `GSI3SK` under a condition on the value just read — `ADD` can't keep a
  derived sort key in sync itself, and this step has to run even when the
  award above was rejected or exhausted its retries, since a concurrent award
  may have moved `points` in the meantime regardless.
- Reversal: when a published meme is flagged (`active`/`listed` → `pending_review`
  or `removed`), its `AWARD#UPLOAD#<memeId>` is deleted and its points
  subtracted back out of the period totals; if its creator's first clean meme
  had qualified a referral (`qualifyingMemeId` match), that referral award is
  reversed too. Daily counters are deliberately left untouched — only the
  ledger and the totals it fed move. Like/comment awards already given
  against that meme are not reversed; nothing in KAN-101 asked for that.
- Referral (model A): `ShareBar` appends `&refBy=<sharerId>` (not `ref` — that
  param already means something else, see `visit_from_share` below) when the
  sharer is signed in. `components/ReferralCapture.tsx`, mounted at the root
  layout, stores the first `refBy` it ever sees in `localStorage`
  (first-touch). `POST /api/users` sends that stored value as `ref` on every
  call; after its normal profile upsert it separately calls `attachReferrer`,
  which validates the referrer exists and writes `referredBy` on the caller's
  own `USER#` item, conditioned on `attribute_not_exists(referredBy) AND
  createdAt > now - REFERRAL_ATTACH_WINDOW_HOURS` (24h) — so a stale
  `?refBy` sitting in a browser for months can no longer attach, and only the
  first successful attempt ever wins. This is a second write, after the one
  that actually creates the `USER#` item (wallet sign-up's `USER#` row is
  created earlier still, by `/api/auth/wallet/verify`'s own `upsertUser`
  call) — so StreamHandler treats `referredBy` appearing on either an INSERT
  or a MODIFY as the trigger for writing the `REFERREDBY` marker, not INSERT
  alone. The referral award itself only fires later, off the referred user's
  first clean `MEME#` INSERT (detected via `adjustLeaderboard`'s previous
  count being 0) — attaching a referrer after the user already has memes
  never awards anything, since that check only ever runs at insert time.
- `ref=share&ch=<channel>` (see `visit_from_share` in
  `docs/ANALYTICS_EVENTS.md`) and `refBy=<sharerId>` are independent query
  params on the same share link, carried by the same `ShareBar` click, read by
  two unrelated pieces of code.
- Read: `GET /api/points/me` (authenticated) returns the caller's current
  weekly and all-time totals only — no daily figure. The leaderboard tab's
  Daily/Weekly/All-time toggle reads `getPointsLeaderboard`, a `Query` on
  GSI3 by `GSI3PK = LB#<period>` (today's UTC day or ISO week, or
  `LB#ALLTIME`), `ScanIndexForward: false`, `Limit: 50` — there's no way to
  browse a past day or week today.
- `app/leaderboard`'s "Top by Points" tab shows real users only, never
  `MOCK_CREATORS` — the points program only means something for an account
  that can actually earn.

## Materialized view invariant (KAN-67)

No Streams-maintained row may exist without its parent item. `LB#DAY#`,
`LB#WEEK#`, `LB#ALLTIME`, `POINTS#<userId>` and `LEADERBOARD#GLOBAL` rows
require `USER#<userId>` to exist. `FEED#GLOBAL` and `REPORTQUEUE#GLOBAL` rows
require their `MEME#<memeId>` item. StreamHandler
(`lambdas/stream-handler/index.ts`) is the only writer of these rows and
enforces the invariant at write time; nothing else checks it or repairs it
afterwards.

- User-parented rows: `awardPoints` and the `LEADERBOARD#GLOBAL` increment
  both call `userExists` (a strongly consistent `GetItem` on the `USER#`
  item) first and write nothing if it is missing. This is a read before the
  write, not a condition inside the write, so it relies on the fact that no
  path in `app/` or `lib/` deletes a `USER#` item. Deleting one by hand
  leaves its rows behind. The `REFERREDBY` marker has no such check: it is
  only ever written off that user's own `USER#` stream record.
- `awardPoints` also writes nothing when the source item's `createdAt` does
  not parse as a date. Without that, the award lands in the literal buckets
  `LB#DAY#NaN-NaN-NaN` and `LB#WEEK#NaN-WNaN`, which no leaderboard read can
  reach. This check covers awards only; the `LEADERBOARD#GLOBAL` count does
  not depend on `createdAt`.
- Meme-parented rows: a `FEED#GLOBAL` row is only written from the meme's own
  `MEME#` stream record, and a `REPORTQUEUE#GLOBAL` row only after a `GetItem`
  finds the `MEME#` item. Both are deleted when that meme's `MEME#` item is
  removed (see REMOVE below).
- Rows that reach zero are deleted, not left at 0. A `LEADERBOARD#GLOBAL`
  decrement is conditioned on `memeCount > 0`, so it can neither create a row
  nor go negative, and the row is deleted when the count reaches 0
  (conditioned on it still being 0, so a concurrent increment wins). A period
  total whose `points` is 0 or less is deleted by the same always-run step
  that otherwise resyncs `GSI3SK`, under the same condition on the value just
  read.
- REMOVE: a hard-deleted `MEME#` item (in any status) has its
  `AWARD#UPLOAD#<memeId>` and any referral award it qualified reversed, and
  its `REPORTQUEUE#GLOBAL` row deleted, in addition to the feed and
  leaderboard cleanup a clean meme already got. This is the same reversal the
  flagged-meme path in Points & leaderboard above uses. Each subtraction from
  a period total is conditioned on the row existing, so reversing against a
  total that is already gone (TTL-expired `LB#DAY#`, or deleted at zero) is a
  no-op instead of recreating it with negative points.
- Observability: every award skipped by the two `awardPoints` checks emits
  `MemeDay/PointsAwardSkipped`, dimensioned by `Stage` and `Reason`
  (`no_user` or `bad_created_at`), and logs a warning. There is no alarm on
  it today. In prod every earner has a `USER#` item and every source item has
  `createdAt`, so a nonzero value there means a real user silently lost
  points. A skipped `LEADERBOARD#GLOBAL` increment emits nothing of its own.

## Buffer (X promotion) (KAN-84)

A daily Vercel Cron queues the Meme of the Day to two X channels through the
Buffer GraphQL API (`https://api.buffer.com`). Code: `vercel.json`,
`app/api/cron/buffer-motd/route.ts`, `lib/buffer.ts` (server-only).

- Queue-only. The route creates each post with `mode: addToQueue` and
  `schedulingType: automatic`, so Buffer publishes it at that channel's next
  queue slot (12:00 Europe/Ljubljana, configured in the Buffer UI, not in this
  repo). It never uses `shareNow` or a custom `dueAt`. The cron time (08:00
  UTC) only has to be earlier than the slot.
- Source: `getMemeOfDay()` in `lib/db.ts`, unchanged. No meme means a logged
  200 with `result: "no_meme"`.
- Same post on every channel in `BUFFER_CHANNEL_IDS`. Each channel is handled
  on its own: one failing does not stop the other. The response lists a
  per-channel result (`queued`, `skipped_same_meme`, `error`) and is HTTP 500
  if any channel errored or if the run could not start (see the two bullets
  below), 200 otherwise.
- Image: only an absolute `https://` `imageUrl` (the CloudFront URL) is sent.
  Buffer downloads the image at publish time, hours later, so a relative
  `/api/image/...` path (`CLOUDFRONT_DOMAIN` unset) or any expiring URL would
  fail. In that case the route logs an error and queues nothing.
- Permalink: `<base>/meme/<id>`, base from `metadataBaseUrl()` in
  `lib/metadata-url.ts` (`NEXT_PUBLIC_APP_URL` when usable, else the request
  host). A base that is not `https://` logs an error and queues nothing.
- Dedup via Buffer post history, no DB state. Before queueing, the route reads
  that channel's most recently created post (statuses `sent` and `scheduled`)
  and skips the channel if its text already contains this meme's permalink.
  This is what stops the same top meme being posted on consecutive days, and
  what makes a second run on the same day a no-op. It depends on Buffer
  storing the link as written: link shortening must be OFF on both channels.
  There is no duplicate-run lock and no missed-run recovery.
- No DynamoDB reads beyond `getMemeOfDay()`, no writes, no new item types, no
  GSI, no CDK or IAM change.
- Post text: one of five fixed templates picked at random, then the permalink,
  then the two hashtags `#memes #Solana` (`POST_HASHTAGS`, kept to two because
  X recommends at most 2 per post). The caption is truncated with an ellipsis
  so the whole post, hashtags and their spaces included, is at most 280
  characters as X counts them (any URL is 23; emoji, CJK and the ellipsis
  itself are 2). Only the caption is ever shortened.
- Rate limits: on HTTP 429 the route does not retry. It logs the `Retry-After`
  value and reports that channel as `error`.
- Env vars, all three server-only (never `NEXT_PUBLIC_`), set in Vercel
  Production:
  - `BUFFER_API_KEY`: Buffer API key, sent as a bearer token.
  - `BUFFER_CHANNEL_IDS`: comma-separated Buffer channel IDs.
  - `CRON_SECRET`: Vercel sends it as `Authorization: Bearer <CRON_SECRET>` on
    cron calls. The route compares it in constant time and returns 401 on any
    mismatch, and also when the variable is unset or empty (fail closed).
  The Buffer organization ID the posts query needs is looked up from the
  channel at runtime, not configured.

## Observability

- SNS topic `memeday-alerts` (prod) / `memeday-alerts-dev`, email
  subscriptions from stack props.
- CloudWatch alarms, prod only (`MemeDayDev` creates none, KAN-106), all on a
  5-minute window with `NOT_BREACHING` on missing data: Errors > 0 for each
  of StreamHandler, S3Handler and ModerationHandler;
  DynamoDB `ThrottledRequests` > 0 on the table and its GSIs (PAY_PER_REQUEST
  can still throttle); `MemeDay/RateLimitCounterFailure` > 20, dimensioned by
  `Stage`, which is the only signal that the fail-open rate limiter is
  silently letting everything through; `MemeDay/PointsAwardFailure` > 0,
  dimensioned by `Stage` (KAN-101) — a genuine infra fault in the points path
  (StreamHandler's `emitPointsAwardFailureMetric`), not a cancelled
  transaction, which is an expected outcome and never emits this.
- `MemeDay` is the custom metric namespace. Keep any future metric under it.
- PostHog product analytics from the client (`lib/analytics.ts`). The event
  vocabulary is a closed list mirrored in `docs/ANALYTICS_EVENTS.md`, and
  `test/analytics-events.test.js` fails if the two drift.

## IAM (KAN-17)

The Vercel runtime uses a dedicated IAM user, `memeday-runtime-prod` /
`memeday-runtime-dev`, with a scoped inline policy. The action lists were
grepped from actual SDK calls in `app/` and `lib/`, not guessed:
- DynamoDB `GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, `Query`,
  `BatchGetItem` on the table and its indexes. `Scan` excluded on purpose.
- The exact 10 Cognito actions used across `app/api/auth/**`.
- S3 `PutObject` on `uploads/*` only. `GetObject` excluded on purpose
  (KAN-38), which is what disables the `/api/image` proxy in deployment.
- CloudWatch `PutMetricData`, conditioned on namespace `MemeDay`.

These users predate the stack and each needs a one-time `cdk import` per
stack to be adopted into CloudFormation before `cdk deploy` will succeed.

Lambdas have their own execution roles. S3Handler and ModerationHandler get
S3 access scoped to `uploads/*`, and `lambda:InvokeFunction` on
ModerationHandler specifically, not `*`. StreamHandler additionally gets
CloudWatch `PutMetricData` conditioned on namespace `MemeDay` (KAN-101, for
`PointsAwardFailure` and `PointsAwardSkipped`), same condition-only scoping as 
the runtime user's grant above.

## Admin

There are no admin routes, admin roles, or moderation review UI in the
codebase today. `pending_review` is a terminal state with no path out of it.
An operator review path is PLANNED and unbuilt.

## Data flow rules (directives)
- Feed reads, voting, CRUD, and auth callbacks go through Vercel API routes.
- Stream and S3-triggered work goes through Lambda. Cron-triggered and
  server-side-signing Lambdas do not exist yet; adding either means adding
  the trigger and the role, not repurposing an existing function.
- Trending / Leaderboard / Daily featured are served from materialized
  views (Streams to Lambda), never computed live from base items.
- Media uploads go client to S3 (presigned), not client to Vercel to S3.
- Media reads go through CloudFront. Clients never read the S3 bucket
  directly. The `/api/image` proxy is not a working production fallback; see
  Media above.
- `userId` is the Cognito `sub`; do not generate user IDs elsewhere.
- Wallet login verifies the signature in the `/api/auth/wallet/verify` API
  route, then issues a Cognito session via admin-initiated auth; do not build
  a parallel session/JWT system alongside Cognito.
- Client code gets access tokens from `getAccessToken()` (`lib/session.ts`),
  never by reading `cognitoToken` out of the store. Reading the store directly
  sends whatever is in `localStorage`, expired or not.
- Never read `SOLANA_*` or hardcode a cluster outside `lib/solana/network.ts`.
- Never hardcode a rate limit outside `lib/rate-limit-config.ts`.
- Every new send-and-confirm path must poll `getSignatureStatuses`; the RPC
  proxy cannot hold a WebSocket open.
- Every new RPC method must be added to `lib/solana/rpc-allowlist.ts` or it
  will 403.
- Ownership and listing changes must be owner-gated at the DB via
  `ConditionExpression` when resale is built; never bypass that in
  application code.
- User on-chain actions are signed client-side. Platform on-chain actions are
  PLANNED to be signed server-side in Lambda; no such path exists yet.
- Bags.fm token launch is a link-out (KAN-29); MemeDay never signs a Bags
  transaction. In-app trading (buy/sell/price) is still mocked (KAN-52). Do
  not wire a real mainnet spend or a server-side Bags signer without explicit
  approval.
