import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { Button, Form, Input, Label, TextField } from 'react-aria-components';
import type { AuthorityRecord, ServerRecord } from '@fctp/client-sdk';
import { discoverServer, readServers } from './application-api';
import type { ServerListResponse } from './application-api';
import { HandleLabel } from './handle-label';
import { RegistryCard } from './registry-card';
import { TerritoryCard } from './territory-card';
import styles from './connections.module.css';

export interface ConnectionsProps {
  accountId?: string;
  onReadResource?: (reference: { id: string }) => void;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function authorityIndex(authorities: readonly AuthorityRecord[]): Map<string, AuthorityRecord> {
  return new Map(authorities.map((authority) => [authority.actorId, authority] as const));
}

function AuthorityEntry({ authority, onReadResource }: { authority: AuthorityRecord; onReadResource?: ConnectionsProps['onReadResource'] }): ReactElement {
  const read = onReadResource === undefined ? undefined : () => onReadResource({ id: authority.actorId });
  const role = authority.roles.includes('registry')
    ? 'registry'
    : authority.roles.includes('territory')
      ? 'territory'
      : authority.roles.includes('home') ? 'home' : undefined;
  return (
    <li className={styles.authority}>
      {role === 'territory' ? (
        <TerritoryCard
          {...(authority.name === undefined ? {} : { name: authority.name })}
          {...(authority.handle === undefined ? {} : { handle: authority.handle })}
          {...(read === undefined ? {} : { onPress: read })}
        />
      ) : role === 'registry' ? (
        <RegistryCard
          {...(authority.name === undefined ? {} : { name: authority.name })}
          {...(authority.handle === undefined ? {} : { handle: authority.handle })}
          {...(read === undefined ? {} : { onPress: read })}
        />
      ) : (
        <HandleLabel
          actorId={authority.actorId}
          {...(authority.handle === undefined ? {} : { handle: authority.handle })}
          {...(authority.name === undefined ? {} : { name: authority.name })}
          {...(role === undefined ? {} : { role })}
          {...(read === undefined ? {} : { onPress: read })}
        />
      )}
      {authority.handle === undefined ? <p className={styles.unpublished}>Unpublished handle</p> : null}
      <p className={styles.roles}>
        Roles: {authority.roles.length === 0 ? 'none listed' : authority.roles.join(', ')}
      </p>
      <p className={styles.hosting}>Hosted by {authority.server}</p>
      <details className={styles.details}>
        <summary>Authority details</summary>
        <dl className={styles.identity}>
          <dt>Authority actor ID</dt>
          <dd>{authority.actorId}</dd>
          <dt>Server</dt>
          <dd>{authority.server}</dd>
          <dt>Published handle</dt>
          <dd>{authority.handle ?? 'Not published'}</dd>
          <dt>Published name</dt>
          <dd>{authority.name ?? 'Not published'}</dd>
        </dl>
      </details>
    </li>
  );
}

function ServerEntry({ server, authorities, onReadResource }: { server: ServerRecord; authorities: Map<string, AuthorityRecord>; onReadResource?: ConnectionsProps['onReadResource'] }): ReactElement {
  const hosted = server.authorities
    .map((actorId) => authorities.get(actorId))
    .filter((authority): authority is AuthorityRecord => authority !== undefined);
  return (
    <li className={styles.server}>
      <p className={styles.origin}>{server.origin}</p>
      <p className={styles.serverName}>{server.name ?? 'Unnamed server'}</p>
      {hosted.length === 0 ? (
        <p className={styles.status}>No authorities are listed for this server.</p>
      ) : (
        <ul className={styles.authorities}>
          {hosted.map((authority) => (
            <AuthorityEntry key={authority.actorId} authority={authority} onReadResource={onReadResource} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function Connections({ accountId, onReadResource }: ConnectionsProps): ReactElement {
  const [directory, setDirectory] = useState<ServerListResponse | undefined>();
  const [retainedFailure, setRetainedFailure] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [discoveryFailure, setDiscoveryFailure] = useState<string | undefined>();
  const [discovering, setDiscovering] = useState(false);
  const contextGeneration = useRef(0);
  const discoveryGeneration = useRef(0);

  useEffect(() => {
    const generation = ++contextGeneration.current;
    const discovery = ++discoveryGeneration.current;
    setLoading(true);
    setRetainedFailure(undefined);
    setDiscoveryFailure(undefined);
    setDiscovering(false);
    readServers().then(
      (response) => {
        if (contextGeneration.current !== generation || discoveryGeneration.current !== discovery) return;
        setDirectory(response);
        setLoading(false);
      },
      (error: unknown) => {
        if (contextGeneration.current !== generation || discoveryGeneration.current !== discovery) return;
        setRetainedFailure(failureMessage(error));
        setLoading(false);
      }
    );
    return () => {
      contextGeneration.current += 1;
    };
  }, [accountId]);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const target = query.trim();
    if (target.length === 0) {
      setDiscoveryFailure('Enter a server origin or an account/authority handle.');
      return;
    }
    const context = contextGeneration.current;
    const discovery = ++discoveryGeneration.current;
    setLoading(false);
    setDiscovering(true);
    setDiscoveryFailure(undefined);
    discoverServer(target.startsWith('@') ? { handle: target } : { origin: target }).then(
      (response) => {
        if (contextGeneration.current !== context || discoveryGeneration.current !== discovery) return;
        setDirectory(response);
        setRetainedFailure(undefined);
        setDiscovering(false);
      },
      (error: unknown) => {
        if (contextGeneration.current !== context || discoveryGeneration.current !== discovery) return;
        setDiscoveryFailure(failureMessage(error));
        setDiscovering(false);
      }
    );
  };

  const authorities = authorityIndex(directory?.authorities ?? []);

  return (
    <section aria-label="Connections" className={styles.connections}>
      <h2 className={styles.heading}>Connections</h2>
      <p className={styles.description}>
        This is a retained discovery directory. Listing does not confirm current reachability or authorization, and it is not
        your active authority configuration.
      </p>
      <Form className={styles.discovery!} onSubmit={submit}>
        <TextField className={styles.field!} value={query} onChange={setQuery} isDisabled={discovering}>
          <Label className={styles.label}>Server origin or account/authority handle</Label>
          <Input className={styles.input!} placeholder="http://server.example:4200 or @name@server.example:4200" />
        </TextField>
        <Button className={styles.submit!} type="submit" isDisabled={discovering}>
          {discovering ? 'Discovering…' : 'Discover'}
        </Button>
      </Form>
      {discoveryFailure === undefined ? null : (
        <p className={styles.failure} role="alert">
          {discoveryFailure}
        </p>
      )}
      <div className={styles.directory}>
        <h3 className={styles.subheading}>Retained discovery directory</h3>
        {loading ? <p className={styles.status}>Loading the retained discovery directory…</p> : null}
        {retainedFailure === undefined ? null : (
          <p className={styles.failure} role="alert">
            {retainedFailure}
          </p>
        )}
        {directory === undefined ? null : directory.servers.length === 0 ? (
          <p className={styles.status}>No servers are listed in the retained discovery directory.</p>
        ) : (
          <ul className={styles.servers}>
            {directory.servers.map((server) => (
              <ServerEntry key={server.server} server={server} authorities={authorities} onReadResource={onReadResource} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
