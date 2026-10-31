import type { AccountRecord, ActionRecord, AuthorityRecord, ServerRecord, SourcedObservation } from '@fctp/client-sdk';
import type { ClientSessionRecord } from './sessions.js';

export interface ClientState {
  servers: Record<string, ServerRecord>;
  authorities: Record<string, AuthorityRecord>;
  accounts: Record<string, AccountRecord>;
  clientSessions: Record<string, ClientSessionRecord>;
  observations: Record<string, SourcedObservation<unknown>>;
  drafts: Record<string, Record<string, unknown>>;
  routePlans: Record<string, Record<string, unknown>>;
  actions: Record<string, ActionRecord>;
  followedRequests: Record<string, Record<string, unknown>>;
  followedJobs: Record<string, Record<string, unknown>>;
}

export function emptyClientState(): ClientState {
  return {
    servers: {},
    authorities: {},
    accounts: {},
    clientSessions: {},
    observations: {},
    drafts: {},
    routePlans: {},
    actions: {},
    followedRequests: {},
    followedJobs: {}
  };
}
