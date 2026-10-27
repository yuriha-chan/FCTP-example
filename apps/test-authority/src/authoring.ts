import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { signJsonLd, createLocalDocumentLoader } from '@fctp/identity';
import { validateModel, validateProduction, type Asset, type AssetGrant, type Production, type URI, type Variety } from '@fctp/protocol';
import type { Authority } from './bootstrap.js';
import type { HomeService } from './home.js';

interface AuthoringState { players: Record<string, { assets: Asset[]; varieties: Variety[]; grants: AssetGrant[]; media: Record<string, string> }> }
export interface AuthoringService {
  catalog(playerId: URI): Promise<{ actor: URI; assets: Asset[]; varieties: Variety[]; grants: AssetGrant[] }>;
}

export function installAuthoring(authority: Authority, home: HomeService, origin: string): AuthoringService {
  const base = origin.replace(/\/$/, '');
  const playerNames = new Map(Object.entries(authority.players).map(([name, player]) => [player.id, name]));
  const loader = createLocalDocumentLoader(new Map(Object.values(authority.keys).map(({ keyPair, publicKey }) => [keyPair.id, publicKey])));
  const service: AuthoringService = {
    async catalog(playerId) {
      if (!playerNames.has(playerId)) throw new TypeError('unknown-local-player');
      return authority.server.store.read((state) => {
        const player = (state.domain.authoring as AuthoringState | undefined)?.players[playerId];
        return { actor: playerId, assets: structuredClone(player?.assets ?? []), varieties: structuredClone(player?.varieties ?? []), grants: structuredClone(player?.grants ?? []) };
      });
    }
  };
  authority.server.addRoute(async ({ request, response, url }) => {
    const send = (status: number, body: unknown): void => json(response, status, body);
    const mediaMatch = /^\/objects\/players\/[^/]+\/media\/([^/]+)$/.exec(url.pathname);
    if (mediaMatch && request.method === 'GET') {
      const mediaId = `${base}${url.pathname}`;
      const text = await authority.server.store.read((state) => Object.values((state.domain.authoring as AuthoringState | undefined)?.players ?? {}).map((player) => player.media[mediaId]).find((value) => value !== undefined));
      if (text === undefined) send(404, { error: 'not-found' });
      else { response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=0, must-revalidate' }); response.end(text); }
      return true;
    }
    const collection = /^\/objects\/players\/([^/]+)\/creations$/.exec(url.pathname);
    if (collection && request.method === 'GET') {
      const player = authority.players[decodeURIComponent(collection[1]!)];
      if (!player) { send(404, { error: 'not-found' }); return true; }
      const catalog = await service.catalog(player.id);
      send(200, { '@context': 'https://www.w3.org/ns/activitystreams', id: url.href, type: 'OrderedCollection', totalItems: catalog.assets.length + catalog.varieties.length + catalog.grants.length, orderedItems: [...catalog.assets, ...catalog.varieties, ...catalog.grants] });
      return true;
    }
    if (!url.pathname.startsWith('/local/authoring')) return false;
    if (request.method !== 'GET' && request.method !== 'POST') { send(404, { error: 'not-found' }); return true; }
    const playerId = await authenticate(request, home);
    if (!playerId) { send(401, { error: 'unauthorized' }); return true; }
    if (request.method === 'GET' && url.pathname === '/local/authoring') { send(200, await service.catalog(playerId)); return true; }
    if (request.method !== 'POST' || !['/local/authoring/assets', '/local/authoring/varieties'].includes(url.pathname)) { send(404, { error: 'not-found' }); return true; }
    try {
      const body = await readObject(request);
      const name = requiredString(body, 'name');
      const playerName = playerNames.get(playerId)!;
      const collectionRoot = `${base}/objects/players/${encodeURIComponent(playerName)}`;
      const id = (): URI => `${collectionRoot}/${randomBytes(16).toString('hex')}`;
      if (url.pathname.endsWith('/assets')) {
        rejectKeys(body, ['name', 'text']);
        const text = requiredString(body, 'text', true);
        const assetId = id(); const mediaId = `${collectionRoot}/media/${randomBytes(16).toString('hex')}`;
        const asset = await signJsonLd({ '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'], id: assetId, type: 'Asset', name, creator: [playerId], holder: playerId, media: [{ url: mediaId, mediaType: 'text/plain' }] }, authority.keys[playerName]!.keyPair, loader) as unknown as Asset;
        const activityId = id();
        await authority.server.commit((domain) => { const state = (domain.authoring ??= { players: {} }) as AuthoringState; const row = (state.players[playerId] ??= { assets: [], varieties: [], grants: [], media: {} }); row.assets.push(asset); row.media[mediaId] = text; }, [], [{ actorId: playerId, object: asset as unknown as Record<string, unknown>, activityId }]);
        send(201, { asset, activity: await archived(authority, playerId, activityId) }); return true;
      }
      rejectKeys(body, ['name', 'mass', 'version', 'asset', 'production']);
      if (typeof body.mass !== 'number' || !Number.isFinite(body.mass) || body.mass <= 0) throw new BadRequestError('mass must be finite and positive');
      const version = requiredString(body, 'version');
      let assetId: string | undefined;
      if (Object.hasOwn(body, 'asset')) {
        if (typeof body.asset !== 'string' || !URL.canParse(body.asset)) throw new BadRequestError('asset must be an absolute URI');
        assetId = body.asset;
        const own = await authority.server.store.read((state) => (state.domain.authoring as AuthoringState | undefined)?.players[playerId]?.assets.some((asset) => asset.id === assetId));
        if (!own) { send(403, { error: 'asset-not-owned' }); return true; }
      }
      let production: Production[] | undefined;
      if (Object.hasOwn(body, 'production')) {
        if (!Array.isArray(body.production)) throw new BadRequestError('production must be an array');
        for (const item of body.production) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) throw new BadRequestError('production entries must be objects');
          const checked = validateModel<Production>(item, 'Production');
          if (!checked.success || validateProduction(item as Production).length || (Array.isArray(item.location) && item.location.some((area: unknown) => !validateModel(area, 'Area').success))) throw new BadRequestError('invalid production');
        }
        production = structuredClone(body.production) as Production[];
      }
      const varietyId = id();
      const variety = await signJsonLd({ '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'], id: varietyId, type: 'Variety', name, holder: playerId, mass: body.mass, version, ...(assetId ? { asset: assetId } : {}), ...(production ? { production } : {}) }, authority.keys[playerName]!.keyPair, loader) as unknown as Variety;
      const grant = assetId ? await signJsonLd({ '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'], id: id(), type: 'AssetGrant', asset: assetId, variety: varietyId, grantee: playerId }, authority.keys[playerName]!.keyPair, loader) as unknown as AssetGrant : undefined;
      const activityId = id();
      await authority.server.commit((domain) => { const state = (domain.authoring ??= { players: {} }) as AuthoringState; const row = (state.players[playerId] ??= { assets: [], varieties: [], grants: [], media: {} }); row.varieties.push(variety); if (grant) row.grants.push(grant); }, [], [{ actorId: playerId, object: variety as unknown as Record<string, unknown>, activityId }, ...(grant ? [{ actorId: playerId, object: grant as unknown as Record<string, unknown>, activityId: id() }] : [])]);
      send(201, { variety, activity: await archived(authority, playerId, activityId), ...(grant ? { grant } : {}) }); return true;
    } catch (error) {
      if (!(error instanceof BadRequestError)) throw error;
      send(400, { error: error.message }); return true;
    }
  });
  return service;
}

async function archived(authority: Authority, actorId: URI, activityId: URI): Promise<unknown> { return authority.server.store.read((state) => state.outboxArchive.find((item) => item.actorId === actorId && item.activity.id === activityId)?.activity); }
async function authenticate(request: IncomingMessage, home: HomeService): Promise<URI | undefined> { const value = request.headers.authorization ?? ''; return value.startsWith('Bearer ') ? home.authenticateNativeToken(value.slice(7)) : undefined; }
async function readObject(request: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); let value: unknown; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (error) { if (error instanceof SyntaxError) throw new BadRequestError('malformed JSON'); throw error; } if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestError('request must be an object'); return value as Record<string, unknown>; }
function requiredString(body: Record<string, unknown>, key: string, allowEmpty = false): string { const value = body[key]; if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) throw new BadRequestError(`${key} must be a nonempty string`); return value; }
function rejectKeys(body: Record<string, unknown>, allowed: string[]): void { if (Object.keys(body).some((key) => !allowed.includes(key))) throw new BadRequestError('unsupported request field'); }
class BadRequestError extends Error {}
function json(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); }
