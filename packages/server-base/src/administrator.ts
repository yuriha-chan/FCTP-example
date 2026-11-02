import { originForServer, parseHandle } from '@fctp/identity';
import type { URI } from '@fctp/protocol';

export interface ConfiguredAdministrator {
  actorId: URI;
  homeActorId: URI;
}

export function configuredAdministrator(handle: string): ConfiguredAdministrator {
  const parsed = parseHandle(handle);
  if (parsed.kind !== 'account') throw new TypeError('Configured administrator must be an account handle');
  const origin = originForServer(parsed.server);
  return {
    actorId: `${origin}/actors/${parsed.localName}` as URI,
    homeActorId: `${origin}/actors/home` as URI
  };
}
