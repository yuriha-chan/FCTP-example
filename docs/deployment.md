# Separate Docker deployments

Each directory under `docker/` is a standalone service with its own Dockerfile, Compose project, data volume, port, configuration, and secrets. The four services are Authority (Home, Registry, and authoring), Policy Territory, Simulation Territory, and the browser Client. They have no Compose startup dependencies or shared service names; each service can be operated independently.

## Configure and start

Copy each `config.example.json` to `config.json`, and `.env.example` to `.env` in the service directory. Replace every `example.org` origin with the canonical public HTTPS origin that service will advertise and receive requests under. Keep the same Authority origin and Player names (`player`, `player-2`) in all service configurations. The Authority example explicitly names governor and the Player accounts. Authority, Policy, and Simulation name the same `administrator` handle; Authority also creates that account as a Home governor through `administratorNames`. The Client has no administrator bindings; an account claims administration roles through its Home server.

The Authority configuration accepts `startingPorts`, an array of absolute published Port URIs (default empty), and `vesselNames`, an optional partial map from configured Player name to local vessel name. Omitting `vesselNames` or setting it to `{}` preallocates no vessels, so authenticated accounts can use initial-vessel onboarding. A deployment may preallocate selected vessels by naming those Players. Every configured local name must be unique and URL-safe, and the map must not name an unconfigured Player. Every `startingPorts` entry must be an absolute HTTP(S) URI without userinfo. Configuration is validated before startup writes. Recommendations are not admission or proof of reachability; operators must publish the exact Port resources and responsible Territory Actors, and must configure destination building admission.

The example preallocates no vessels and lists `https://west.example.org/objects/ports/east` as a recommendation. Replace it with a Port that the deployment actually publishes and can resolve. A recommendation does not grant permission to land.

### Authority image object storage

Authority supports optional S3-compatible image storage configured with `objectStorage.endpoint`, `publicBaseUrl`, `region`, `bucket`, `accessKeyIdFile`, `secretAccessKeyFile`, and optional `forcePathStyle`. The endpoint must be an HTTP(S) origin and is the private, authenticated S3 API endpoint. `publicBaseUrl` is required and separate: it is the explicit public HTTP(S) base used to construct every returned media URL. It may include a path prefix such as `https://media.example.org/site/media` or `http://127.0.0.1:4104/image-bucket`; a trailing slash is normalized. Authority never derives the public URL from the API endpoint or its own origin. Credential files are read by Authority; the S3 credentials are service credentials and are not browser or Client credentials. Without object storage, text authoring remains available and image upload is unavailable.

Uploaded images are written once to the designated bucket with a 128-bit random key and are immediately readable by anyone who knows the returned URL. This is bearer-link access, not account-based authorization: possession of the URL is enough to read the bytes before or after publication. Do not upload sensitive images to this store. Publication does not copy, delete, rewrite an ACL, or otherwise transition the object; it verifies that the exact URL and media type belong to the uploading account's retained metadata and signs that public reference into the Asset. Deleting or overwriting a bucket object breaks previously published references, so treat keys and bytes as durable. Automatic deletion, garbage collection, quotas, and image transformations are not provided.

The Authority Compose project includes RustFS with a durable named data volume and a one-shot initializer using the existing Authority Node SDK. The initializer creates the designated bucket and applies an anonymous `s3:GetObject` policy scoped to `arn:aws:s3:::image-bucket/*`. It grants no public write, list, delete, or policy action. RustFS is optional when operating Authority without image storage. Compose publishes the RustFS S3 API on `RUSTFS_BIND_ADDRESS:RUSTFS_API_PORT` (default `127.0.0.1:4104`) to container port `9000`; the example public base is `http://127.0.0.1:4104/image-bucket`. Keep the default loopback bind unless browsers genuinely need direct access. For remote access, terminate TLS and forward the public media path to that API, set `publicBaseUrl` to the externally reachable HTTPS URL, and do not publish the internal `rustfs:9000` address. Public keys are immutable and unguessable, so a front proxy may cache successful image responses aggressively; do not cache authorization failures as successful media, and do not attach native credentials to public media requests. RustFS routing must preserve the bucket path when the public base includes it.

For production or a custom media domain, Cloudflare R2 is a supported S3-compatible choice. Create the bucket and public custom domain in R2 as an operator task and point `publicBaseUrl` at that public domain. R2 bucket policy, public-domain, CORS, and cache behavior are managed in R2; the generic Authority application does not call provider-specific policy APIs. Keep the R2 S3 API endpoint private and distinct from the public media domain.

For deployments using image storage, back up both the object-store data and Authority metadata together; restoring only one may leave metadata without bytes or orphaned bytes. A lost upload response or orphaned object can require operator follow-up.

The S3 credential files must be readable by Authority UID 1000 and RustFS UID 10001. Compose adds supplementary group 1000 to RustFS and mounts only the two S3 credential files into that service: give those files group 1000 and mode 0640, accounting for host UID/GID mapping. Keep other Authority secrets at mode 0600, readable only by their intended service user. RustFS `_FILE` credential-variable support is verified in upstream `main`, not in the deployed `latest` image; the Compose stack has not been runtime-verified here.

Create a `secrets/` directory in the Authority, Policy, and Simulation service directories. The Client uses no secret files. Store secrets as UTF-8 files without surrounding quotes; a single final newline is accepted. Images run as the `node` user (UID/GID `1000`), so bind-mounted config and secrets must be readable by that container user. On a normal rootful Linux Docker host, give the secrets directory and files UID `1000` ownership and modes `0700`/`0600`, or use a narrowly scoped ACL for that UID. Account for host UID mapping when using rootless Docker or user namespaces; do not make secrets world-readable. Do not put secret values in the JSON examples, `.env`, source control, image, or command-line arguments.

Authority secrets:

```text
docker/authority/secrets/admin-secret
docker/authority/secrets/account-passwords.json
```

`account-passwords.json` is a JSON object with a nonempty password for every configured account, for example `player`, `player-2`, and `governor`. Choose private passwords and distinct administrator secrets; no example password or secret is supplied. Policy and Simulation each need `secrets/admin-secret`. The Client needs no administrator secrets or bindings. An account claims an administration role through its Home server; Home verifies the claim against the target and stores the resulting entry.

Run Compose separately for each service from the repository root:

```sh
docker compose --env-file docker/authority/.env -f docker/authority/compose.yaml up -d --build
docker compose --env-file docker/policy/.env -f docker/policy/compose.yaml up -d --build
docker compose --env-file docker/simulation/.env -f docker/simulation/compose.yaml up -d --build
docker compose --env-file docker/client/.env -f docker/client/compose.yaml up -d --build
```

The default published host address is `127.0.0.1`, with host ports Authority `4100`, Policy `4101`, Simulation `4102`, Client `4103`, and the Authority Compose RustFS public-media API `4104`; service containers listen on `8080` and RustFS listens on `9000` internally. Set `BIND_ADDRESS` in the relevant `.env` for service APIs, or `RUSTFS_BIND_ADDRESS` / `RUSTFS_API_PORT` in the Authority `.env` for the media API, only when an operator intentionally needs a different host bind. Compose project names and named data volumes are distinct per service.

The Dockerfiles enable Corepack, activate the latest pnpm, and install from `pnpm-lock.yaml`. The pnpm store is a BuildKit cache mount shared by all four images (`id=pnpm`, `/pnpm/store`), so service builds reuse downloaded packages. BuildKit must remain enabled; it is the default in current Docker Compose. The cache contains package content only, not service state or secrets.

## NodeInfo build identity

Every service exposes public NodeInfo 2.1 discovery:

```text
GET /.well-known/nodeinfo
GET /nodeinfo/2.1
```

The document reports the service name and build git metadata under `software.version` and `metadata.git`. Authority NodeInfo also advertises `metadata.homeAccountName`, the configured Home account name (default `system.home`). The Home Actor keeps the stable URI `<origin>/actors/home` and its persisted signing key; `homeAccountName` only controls the advertised handle, published as `<name>@<authority host>` and resolved through WebFinger as `acct:<name>@<authority host>`. Configure it in the Authority deployment JSON as a name followed by `.home`, without an authority or leading `@`. Build metadata is injected at image build time; the image does not read `.git` at runtime.

Authority also accepts `registryAccountName` (default `system.registry`), while Policy and Simulation accept `territoryAccountName` (default `system.territory`). These fields control the published authority handles, not Actor URIs or persisted keys. `serverDisplayName` defaults to the canonical origin host. Authority derives `homeDisplayName` and `registryDisplayName` from `serverDisplayName` with ` Home` and ` Registry` suffixes; Policy and Simulation derive `territoryDisplayName` with a ` Territory` suffix. The server display name is published as `/local/info` `name`; Actor display names are published as the Actor document `name`.

Compose reads these values from the service `.env` file:

```sh
GIT_COMMIT="$(git rev-parse HEAD)" \
GIT_DESCRIBE="$(git describe --tags --always --dirty)" \
GIT_DIRTY="$(test -n "$(git status --porcelain)" && echo true || echo false)" \
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
docker compose --env-file docker/authority/.env -f docker/authority/compose.yaml build
```

`GIT_DESCRIBE` is preferred for `software.version`; otherwise `GIT_COMMIT` is used, and both default to `unknown`. These values identify the deployed revision; they do not change protocol state or authorization.

## Proxy, origins, and peer reachability

Place a TLS-terminating reverse proxy in front of each service. Configure public DNS and certificates for the canonical origins in the JSON configs. Forward the complete path space, including `/local/`, `/objects/`, and `/api/`, without path-prefix rewriting; preserve the canonical request `Host` and externally visible scheme/host. These origins are protocol identities used in published Actor, resource, and route IDs. They must resolve and be reachable from every container that calls a peer; do not configure a Compose hostname or private container address as a peer identity.

Policy's default public port is East Haven; West Haven remains private. Its default routes are the existing Island Approach and Coastal Passage, and the examples do not add a cross-Territory connecting route. Simulation accepts the named peer for federation and uses that peer's canonical origin for imported metal; this does not create a movement route. Admission and production retain their application defaults. Simulation does not advance ticks automatically.

Initial-vessel landing is governed only by `vesselBuildingRegistry`, and its default empty allowlist rejects every Registry. To accept vessels built by the Authority Registry, add that Registry Actor URI to the destination Territory's `vesselBuildingRegistry`. The entry lists (`trustedRegistry`, `acceptedRegistry`, `acceptedTerritory`) and `requireExitEvidence` do not grant or deny creation landing. A recommended starting Port does not grant landing permission, and this configuration does not make an unpublished Port reachable.

## Credentials and federation provisioning

The Authority's configured Home accounts are created from the password file, with account credentials retained by the Authority. The configured `administrator` must be a local account for Authority; Policy and Simulation may configure an account on another origin. TokenDigest and TokenRevoke issuer authority is resolved from the Player Actor's origin through NodeInfo 2.1 `metadata.homeAccountName` and WebFinger, independently of the target's administrator configuration. The discovery endpoints and resolved Home Actor must be reachable when declarations are processed; local enrollment is not a fallback. Login destinations and native-token routing are unchanged. The administrator signs in through the Client; the Client backend derives the target's diplomatic token from the retained native token. The Client does not receive or store administrator secret files. Deployment configuration and administrator secrets stay backend-only; they are not served as browser configuration.

Provision per-Territory token digests through the Authority's existing Home admin API after the services are reachable. Provision each Player and the configured administrator account so the Registry and Territories can verify their derived tokens. A successful password login issues the account's native credential if none exists. Alternatively, POST `/local/home/issue` with that Actor URI in `actor` and retain the returned native token privately. `/issue` is not idempotent: do not repeat it as a readiness check or routine restart step. Then POST `/local/home/digest-request` with **both** the account's Actor URI in `actor` and each Registry/Territory Actor URI in `resourceActor` to queue its digest. The administrator's native token stays in the Client backend; the Client derives target-specific tokens from it. For example, the digest request JSON for one account is:

```json
{
  "actor": "https://authority.example.org/actors/player-2",
  "resourceActor": "https://west.example.org/actors/territory"
}
```

Both admin endpoints require `Authorization: Bearer <Authority admin secret>` and JSON content type. The digest request resolves the Territory's public Actor document and queues delivery; it does not invent or seed protocol state. Follow delivery through the services' normal workers and verify the resulting Player access before operation. The standalone launcher does not preissue native tokens or digest records. Browser and harness callers receive a separate client-session token; native credentials remain at the Client backend. Sessions have no added expiry or automatic Home-disable synchronization policy.

A resource server that has no retained declaration for an account may instead retrieve the current `TokenDigest` or `TokenRevoke` directly from the account's Home. The client supplies the acting Player Actor in `X-FCTP-Account`; the resource server resolves the Home and sends the signed `GET /local/home/token-digest` request described in the Basic API conventions. This requires no administrator secret and does not authorize the account by itself: the resource server must still verify the presented diplomatic token. Provisioning remains useful for pre-delivery and for confirming rotation.

## Persistence, upgrades, and backups

Each service writes its store under `/data`; protocol services also persist signing keys there. Keep each service's named volume across container recreation and back up the matching volume as one unit. Restore a volume only to the same service identity and canonical origin. Keep account names and service origins stable: changing them changes advertised identities, and changing account passwords does not rewrite existing credential hashes. Recreate a service with the same volume to retain its state. No startup ordering is guaranteed; a healthy container only indicates its own local endpoint responds, not that peers are ready or federation delivery is complete.

Changing `vesselNames` or `startingPorts` does not delete retained Registry vessels, requests, or events. Existing stores survive configuration changes and restart; the configured vessel map seeds missing Registry state, and recommendations reflect the current configuration, without replacing retained data.

Stop the service before taking a consistent backup. Treat volumes as private: Authority state includes native credentials, and Client state includes retained world credentials, session digests, and account-owned work. Do not run multiple replicas against the same JSON store or signing-key files. Do not use `docker compose down -v` unless intentionally deleting that service's state.

## Standalone command and configuration

After `npm ci` and `npm run build`, each service can also be run without Docker:

```sh
node scripts/serve.mjs authority /absolute/path/to/authority-config.json
node scripts/serve.mjs policy /absolute/path/to/policy-config.json
node scripts/serve.mjs simulation /absolute/path/to/simulation-config.json
node scripts/serve.mjs client /absolute/path/to/client-config.json
```

These are separate processes, not a command to launch the combined demo. Each requires its own config. Relative data and secret-file paths resolve against that config's directory. Optional `staticRoot` is relative to that directory; when omitted, the Client serves the checkout/image's built frontend assets. `origin` is the exact canonical HTTP(S) origin without a path, query, fragment, credentials, or trailing slash. `listenHost` defaults to `0.0.0.0`, `port` to `8080`, `dataDir` to `/data`, and `workerIntervalMs` to `1000`. Examples set these explicitly. SIGINT/SIGTERM stop listeners and workers; no process launches another service.
