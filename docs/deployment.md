# Separate Docker deployments

Each directory under `docker/` is a standalone service with its own Dockerfile, Compose project, data volume, port, configuration, and secrets. The four services are Authority (Home, Registry, and authoring), Policy Territory, Simulation Territory, and the browser Client. They have no Compose startup dependencies or shared service names; each service can be operated independently.

## Configure and start

Copy each `config.example.json` to `config.json`, and `.env.example` to `.env` in the service directory. Replace every `example.org` origin with the canonical public HTTPS origin that service will advertise and receive requests under. Keep the same Authority origin and Player names (`player`, `player-2`) in all service configurations. The Authority example explicitly names governor and both vessel identities; the Client bindings use the exact Registry/Territory Actor IDs under the corresponding origins.

Create a `secrets/` directory in each service directory. Store secrets as UTF-8 files without surrounding quotes; a single final newline is accepted. Images run as the `node` user (UID/GID `1000`), so bind-mounted config and secrets must be readable by that container user. On a normal rootful Linux Docker host, give the secrets directory and files UID `1000` ownership and modes `0700`/`0600`, or use a narrowly scoped ACL for that UID. Account for host UID mapping when using rootless Docker or user namespaces; do not make secrets world-readable. Do not put secret values in the JSON examples, `.env`, source control, image, or command-line arguments.

Authority secrets:

```text
docker/authority/secrets/admin-secret
docker/authority/secrets/account-passwords.json
```

`account-passwords.json` is a JSON object with a nonempty password for every configured account, for example `player`, `player-2`, and `governor`. Choose private passwords and distinct administrator secrets; no example password or secret is supplied. Policy and Simulation each need `secrets/admin-secret`. The optional Client administrator bindings need copies of the corresponding administrator secrets under the filenames referenced in its config. Use the same values as their respective services. A Client operator must be entrusted with each bound service's secret; independent service operators need not share these secrets. To deploy without those delegated controls, remove the corresponding bindings and credential-file entries (both may be empty).

Run Compose separately for each service from the repository root:

```sh
docker compose --env-file docker/authority/.env -f docker/authority/compose.yaml up -d --build
docker compose --env-file docker/policy/.env -f docker/policy/compose.yaml up -d --build
docker compose --env-file docker/simulation/.env -f docker/simulation/compose.yaml up -d --build
docker compose --env-file docker/client/.env -f docker/client/compose.yaml up -d --build
```

The default published host address is `127.0.0.1`, with host ports Authority `4100`, Policy `4101`, Simulation `4102`, and Client `4103`; each container listens on `8080`. Set `BIND_ADDRESS` in the relevant `.env` only when an operator intentionally needs a different host bind address. Compose project names and named data volumes are distinct per service.

## Proxy, origins, and peer reachability

Place a TLS-terminating reverse proxy in front of each service. Configure public DNS and certificates for the canonical origins in the JSON configs. Forward the complete path space, including `/local/`, `/objects/`, and `/api/`, without path-prefix rewriting; preserve the canonical request `Host` and externally visible scheme/host. These origins are protocol identities used in published Actor, resource, and route IDs. They must resolve and be reachable from every container that calls a peer; do not configure a Compose hostname or private container address as a peer identity.

Policy's default public port is East Haven; West Haven remains private. Its default routes are the existing Island Approach and Coastal Passage, and the examples do not add a cross-Territory connecting route. Simulation accepts the named peer for federation and uses that peer's canonical origin for imported metal; this does not create a movement route. Admission and production retain their application defaults. Simulation does not advance ticks automatically.

## Credentials and federation provisioning

The Authority's configured Home accounts are created from the password file, with account credentials retained by the Authority. Client administrator credentials are available only to the configured exact bindings; no administrator privilege is inferred for other accounts. Deployment configuration and administrator secrets stay backend-only; they are not served as browser configuration.

Provision per-Territory token digests through the Authority's existing Home admin API after the services are reachable. A successful password login issues the Player's native credential if none exists. Alternatively, POST `/local/home/issue` with that Player Actor URI in `actor` and retain the returned native token privately. `/issue` is not idempotent: do not repeat it as a readiness check or routine restart step. Then POST `/local/home/digest-request` with **both** the Player Actor URI in `actor` and each Territory Actor URI in `resourceActor` to queue its digest. For example, the digest request JSON for one Player is:

```json
{
  "actor": "https://authority.example.org/actors/player-2",
  "resourceActor": "https://west.example.org/actors/territory"
}
```

Both admin endpoints require `Authorization: Bearer <Authority admin secret>` and JSON content type. The digest request resolves the Territory's public Actor document and queues delivery; it does not invent or seed protocol state. Follow delivery through the services' normal workers and verify the resulting Player access before operation. The standalone launcher does not preissue native tokens or digest records. Browser and harness callers receive a separate client-session token; native credentials remain at the Client backend. Sessions have no added expiry or automatic Home-disable synchronization policy.

## Persistence, upgrades, and backups

Each service writes its store under `/data`; protocol services also persist signing keys there. Keep each service's named volume across container recreation and back up the matching volume as one unit. Restore a volume only to the same service identity and canonical origin. Keep account names and service origins stable: changing them changes advertised identities, and changing account passwords does not rewrite existing credential hashes. Recreate a service with the same volume to retain its state. No startup ordering is guaranteed; a healthy container only indicates its own local endpoint responds, not that peers are ready or federation delivery is complete.

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
