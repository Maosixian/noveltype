# NovelType account service

Node 24.17 or later, using built-in HTTP, crypto and SQLite. No npm dependencies or public registration endpoint. All data is scoped to the authenticated user. The desktop main process is the client; browsers are rejected by Origin and receive no CORS permission.

## Configuration and deployment

Build from repository root: `docker build -f server/Dockerfile -t noveltype-api .`.
Use a reviewed build context that contains only `server/` and the three required `app/*.cjs` modules. Do not include profile data, novels, credentials, evidence or test profiles in the context or image. `server/.dockerignore` documents that allowlist; Docker only uses a root `.dockerignore` or a Dockerfile-specific ignore file, so use `server/Dockerfile.dockerignore` when building from the repository root.

Required configuration:

- `NOVELTYPE_MASTER_KEY_FILE`: private file containing a base64-encoded random 32-byte key, mounted read-only. `NOVELTYPE_MASTER_KEY` is also accepted for a protected deployment environment. Keep a separate private backup: losing the key makes stored provider credentials unreadable.
- `NOVELTYPE_DATA_DIR`: writable private directory; default `server/data`, container default `/data`. Run as a non-root user and restrict the directory to that service user.
- `NOVELTYPE_ALLOWED_API_BASES`: comma-separated exact HTTPS API base URLs approved by the operator. Default is the official GLM base. API configuration cannot introduce arbitrary server-side URLs; redirects are rejected by the shared provider client.
- `NOVELTYPE_HOST`: default `127.0.0.1`; Docker image sets `0.0.0.0` inside its network namespace.
- `NOVELTYPE_PORT`: standalone default `8787`, Docker image default `3000`. Set explicitly to match the reverse proxy.
- `TRUSTED_PROXY`: optional exact socket-peer IP allowed to supply `X-NovelType-Client-IP`. The trusted reverse proxy must overwrite this header with the verified original client IP. Forwarded headers from other peers are ignored.

Expose the service only through the intended TLS reverse proxy. Do not publish an HTTP listener to the Internet. For a dedicated Docker network, connect only the proxy and service and avoid a host port binding. The image exposes 3000 as metadata; the configured listen port is authoritative.

`GET /health` confirms the process and SQLite read path. The application uses no automatic background translation loop: only an authenticated, explicit preparation call can request the model. Existing bulk translation workers remain independent and paused.

## Create accounts securely

Run `node server/index.cjs create-user` inside the service environment and pass one JSON object through **stdin** with fields `username`, `password`, `role` (`admin` or `user`). Do not put real passwords into command arguments, source files, shell history or deployment logs. The command creates a user once and refuses to replace an existing account. It prints only the created public user object. There is no default or hard-coded administrator password.

Passwords use salted scrypt; sessions use random 256-bit bearer tokens with only their SHA-256 hash stored, expire after seven days, and are revoked by logout. Login is rate-limited per verified client IP and username, with at most four simultaneous password derivations. API keys use AES-256-GCM with user identity as associated data. Database backups contain ciphertext for keys, never plaintext API credentials.

## API contract (protocol 1)

- `POST /v1/auth/login` `{username,password}` → `{token,user:{id,username,role}}`
- `GET /v1/auth/me` → `{user}`
- `POST /v1/auth/logout` → `{ok:true}`
- `GET /v1/settings` → `{provider,baseUrl,model,hasKey}`
- `PUT /v1/settings` admin only; accepts provider/baseUrl/model and optional apiKey/clearKey; returns public settings.
- `POST /v1/test-connection` admin only; explicit small paid provider request; no automatic retry.
- `POST /v1/prepare` `{bookId,index,requestId}` → `{translation,alignment,cached}`. Reusing a request ID returns its durable result or stopped status, never automatically retries an uncertain/failed provider call. Distinct simultaneous requests for the same account and segment coalesce to one provider request. Only one distinct segment per account can be in flight. After process restart, in-flight jobs become unknown and require a fresh explicit request to retry.
- `POST /v1/sync` `{deviceId,cursor,mutations,limit}` → `{acknowledged,accepted,conflicts,changes,cursor,hasMore}`.

Mutations are `{mutationId,kind,key,baseRevision,value}`. `acknowledged` contains IDs; `accepted` contains `{mutationId,kind,key,revision}`, including the original revision for duplicate IDs. Mutation IDs are durably bound to their original content. Reusing an ID for different content is HTTP 409. A stale entity revision is an HTTP 200 CAS conflict with `{mutationId,current}`; the client must preserve the local candidate and resolve it explicitly. Clients should persist outbox data before acknowledging local edits, and persist received changes before advancing their cursor.

Entity kinds:

| Kind | Key | Value |
| --- | --- | --- |
| book | book ID | `{id,title,demo,segmentCount}` |
| chunk | `bookId:chunkNumber` | `{bookId,start,segments:[{source,translation}]}`; 128 segments except the final chunk |
| progress | book ID | `{position,draft,completed,stats:{sessions,characters,seconds}}` |
| games | book ID or built-in `sample` | `{levels,bestRaces,recent}` in the desktop game-progress format; `sample` needs no library book |
| selection | `active` | `{bookId}` |
| alignment | `bookId:segmentIndex` | `{source,translation,alignment}` bound to the current source and translation |

Books must be created before dependent entities. Source text cannot be replaced under an existing book ID. Synchronize all chunks before using that book on a new client. Change pages return the latest state per entity, in revision order; intermediate overwritten values are not a history API. Sync writes and mutation acknowledgements use one SQLite transaction. Requests are capped at 16 MiB, mutation batches at 32, pages at 50 entities / approximately 8 MiB, entities at 2 MiB, and live account content at 128 MiB. Server errors contain sanitized messages and codes, not provider responses, credentials or stack traces.

## Backup and verification

SQLite uses WAL and `synchronous=FULL`. Back up using SQLite's online backup API, or stop the container before copying the complete data directory; do not copy only the main SQLite file while WAL writes are active. Preserve the master key separately. Test restoration into an isolated directory before relying on the backup. Never put server data in Git or release packages.

Run `node --test test/cloud-server.test.cjs` from the repository root. Tests use isolated temporary databases and simulated providers, and cover tenant isolation, session revocation/expiration, encrypted keys, CAS conflicts, durable idempotency, restart behavior, concurrent translation deduplication and failed-request stop behavior.
