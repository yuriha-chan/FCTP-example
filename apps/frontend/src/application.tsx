import { useState, type ReactElement } from 'react';
import { AppShell, type AccountContext } from './app-shell';
import { Connections } from './connections';
import { ResourceReader, type ResourceReference } from './resource-reader';
import './tokens.css';

function ConnectionsWorkspace({ accountId }: AccountContext): ReactElement {
  const [resource, setResource] = useState<ResourceReference | undefined>();
  return (
    <>
      <Connections {...(accountId === undefined ? {} : { accountId })} onReadResource={setResource} />
      <ResourceReader
        resource={resource}
        {...(accountId === undefined ? {} : { accountId })}
        onClose={() => setResource(undefined)}
      />
    </>
  );
}

export function Application(): ReactElement {
  return <AppShell renderTopic={(topic, context) => topic === 'connections' ? <ConnectionsWorkspace {...context} /> : undefined} />;
}
