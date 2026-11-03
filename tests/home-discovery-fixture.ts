import type { FCTPActor } from '@fctp/protocol';
import { parseWebFingerAddress } from '@fctp/identity';

export function homeDiscoveryFetcher(playerOrigin: string, home: FCTPActor, fallback: typeof fetch = async () => new Response(null, { status: 404 })): typeof fetch {
  const origin = new URL(playerOrigin).origin;
  const address = typeof home.webfinger === 'string' ? parseWebFingerAddress(home.webfinger).address : undefined;
  const accountName = address === undefined ? 'system.home' : address.slice(0, address.lastIndexOf('@'));
  const resource = `acct:${accountName}@${new URL(origin).host}`;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === origin && url.pathname === '/.well-known/nodeinfo') {
      return Response.json({ links: [{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1', href: `${origin}/nodeinfo/2.1` }] });
    }
    if (url.href === `${origin}/nodeinfo/2.1`) {
      return Response.json({ version: '2.1', metadata: { homeAccountName: accountName } });
    }
    if (url.origin === origin && url.pathname === '/.well-known/webfinger' && url.searchParams.get('resource') === resource) {
      return Response.json({ subject: resource, links: [{ rel: 'self', href: home.id }] });
    }
    if (url.href === home.id) return Response.json(home);
    return fallback(input, init);
  };
}
