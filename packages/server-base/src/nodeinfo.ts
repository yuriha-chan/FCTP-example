export const NODEINFO_SCHEMA = 'http://nodeinfo.diaspora.software/ns/schema/2.1';

export interface GitBuildMetadata {
  commit: string;
  describe?: string;
  dirty: boolean;
  builtAt?: string;
}

export interface NodeInfoRuntime {
  name: string;
  version: string;
  metadata: { git: GitBuildMetadata };
}

export function readNodeInfo(name: string, env: NodeJS.ProcessEnv = process.env): NodeInfoRuntime {
  const commit = env.FCTP_GIT_COMMIT?.trim() || 'unknown';
  const describe = env.FCTP_GIT_DESCRIBE?.trim() || undefined;
  const dirtyValue = env.FCTP_GIT_DIRTY?.trim().toLowerCase();
  const dirty = dirtyValue === 'true' || dirtyValue === '1';
  const builtAt = env.FCTP_BUILD_TIME?.trim() || undefined;
  return {
    name,
    version: describe ?? commit,
    metadata: {
      git: {
        commit,
        ...(describe === undefined ? {} : { describe }),
        dirty,
        ...(builtAt === undefined ? {} : { builtAt })
      }
    }
  };
}

export function nodeInfoLinks(base: string): { links: Array<{ rel: string; href: string }> } {
  return { links: [{ rel: NODEINFO_SCHEMA, href: `${base}/nodeinfo/2.1` }] };
}

export function nodeInfoDocument(runtime: NodeInfoRuntime): Record<string, unknown> {
  return {
    version: '2.1',
    software: { name: runtime.name, version: runtime.version },
    protocols: [],
    services: { inbound: [], outbound: [] },
    openRegistrations: false,
    usage: { users: { total: 0, activeHalfyear: 0, activeMonth: 0 }, localPosts: 0 },
    metadata: runtime.metadata
  };
}
