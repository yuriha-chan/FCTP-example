import { useCallback, useRef, useState, type ReactElement } from 'react';
import { AppShell, type AccountContext, type TopicContext } from './app-shell';
import { Activity, type ActivityContext } from './activity';
import { Administration } from './administration';
import { Authoring } from './authoring';
import { Connections } from './connections';
import { Explore } from './explore';
import { Production } from './production';
import { VesselTravel } from './vessel-travel';
import { ResourceReader, type ResourceReference } from './resource-reader';
import { navigateToAuthoringEdit, navigateToTopic, routeFromPathname, type AuthoringEditRoute } from './router';
import type { VesselWorkflowContext } from './workflow-context';
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

interface ActivityWorkspaceProps extends AccountContext {
  actionId?: string;
  selectionRevision?: number;
  onOpenContext: (context: ActivityContext) => void;
}

function ActivityWorkspace({ accountId, actionId, selectionRevision, onOpenContext }: ActivityWorkspaceProps): ReactElement {
  const [resource, setResource] = useState<ResourceReference | undefined>();
  return (
    <>
      <Activity
        {...(accountId === undefined ? {} : { accountId })}
        {...(actionId === undefined ? {} : { actionId })}
        {...(selectionRevision === undefined ? {} : { selectionRevision })}
        onReadResource={setResource}
        onOpenContext={onOpenContext}
        supportedContexts={['vessel', 'journey', 'job', 'administration']}
      />
      <ResourceReader resource={resource} {...(accountId === undefined ? {} : { accountId })} onClose={() => setResource(undefined)} />
    </>
  );
}

interface AdministrationWorkspaceProps extends AccountContext {
  authorityId?: string;
  selectionRevision?: number;
  onOpenAction: (actionId: string) => void;
}

function AdministrationWorkspace({ accountId, accountHandle, authorityId, selectionRevision, onOpenAction }: AdministrationWorkspaceProps): ReactElement {
  const [resource, setResource] = useState<ResourceReference | undefined>();
  return (
    <>
      <Administration
        {...(accountId === undefined ? {} : { accountId })}
        {...(accountHandle === undefined ? {} : { accountHandle })}
        {...(authorityId === undefined ? {} : { authorityId })}
        {...(selectionRevision === undefined ? {} : { selectionRevision })}
        onOpenAction={onOpenAction}
        onReadResource={setResource}
      />
      <ResourceReader resource={resource} {...(accountId === undefined ? {} : { accountId })} onClose={() => setResource(undefined)} />
    </>
  );
}

interface AuthoringWorkspaceProps extends AccountContext {
  authoringEdit?: AuthoringEditRoute;
  onOpenAction: (actionId: string) => void;
  onCloseEdit: () => void;
}

function AuthoringWorkspace({ accountId, authoringEdit, onOpenAction, onCloseEdit }: AuthoringWorkspaceProps): ReactElement {
  const [resource, setResource] = useState<ResourceReference | undefined>();
  return (
    <>
      <Authoring
        {...(accountId === undefined ? {} : { accountId })}
        {...(authoringEdit === undefined ? {} : { edit: authoringEdit })}
        onOpenDraft={(kind, draftId) => navigateToAuthoringEdit({ kind, draftId })}
        onCloseEdit={onCloseEdit}
        onOpenAction={onOpenAction}
        onReadResource={setResource}
      />
      <ResourceReader resource={resource} {...(accountId === undefined ? {} : { accountId })} onClose={() => setResource(undefined)} />
    </>
  );
}

interface ExploreWorkspaceProps extends AccountContext {
  context?: VesselWorkflowContext;
  selectionRevision?: number;
  onOpenLogistics: (context: VesselWorkflowContext) => void;
  onOpenProduction: (context: VesselWorkflowContext) => void;
}

function ExploreWorkspace({ accountId, context, selectionRevision, onOpenLogistics, onOpenProduction }: ExploreWorkspaceProps): ReactElement {
  const [resource, setResource] = useState<ResourceReference | undefined>();
  return (
    <>
      <Explore
        {...(accountId === undefined ? {} : { accountId })}
        {...(context === undefined ? {} : { context })}
        {...(selectionRevision === undefined ? {} : { selectionRevision })}
        onOpenLogistics={onOpenLogistics}
        onOpenProduction={onOpenProduction}
        onReadResource={setResource}
      />
      <ResourceReader resource={resource} {...(accountId === undefined ? {} : { accountId })} onClose={() => setResource(undefined)} />
    </>
  );
}

interface LogisticsWorkspaceProps extends AccountContext {
  context?: VesselWorkflowContext;
  selectionRevision?: number;
  onContextChange: (context: VesselWorkflowContext) => void;
  onOpenExplore: (context: VesselWorkflowContext) => void;
  onOpenAction: (actionId: string) => void;
}

function LogisticsWorkspace({ account, accountId, context, selectionRevision, onContextChange, onOpenExplore, onOpenAction }: LogisticsWorkspaceProps): ReactElement {
  const [resource, setResource] = useState<ResourceReference | undefined>();
  return (
    <>
      <VesselTravel
        {...(account === undefined ? {} : { account })}
        {...(context === undefined ? {} : { context })}
        {...(selectionRevision === undefined ? {} : { selectionRevision })}
        onContextChange={onContextChange}
        onOpenExplore={onOpenExplore}
        onOpenAction={onOpenAction}
        onReadResource={setResource}
      />
      <Production
        {...(accountId === undefined ? {} : { accountId })}
        {...(context === undefined ? {} : { context })}
        {...(selectionRevision === undefined ? {} : { selectionRevision })}
        onOpenAction={onOpenAction}
        onReadResource={setResource}
      />
      <ResourceReader resource={resource} {...(accountId === undefined ? {} : { accountId })} onClose={() => setResource(undefined)} />
    </>
  );
}

interface VesselHandoff {
  context: VesselWorkflowContext;
  revision: number;
}

interface WorkflowSelection {
  accountId: string;
  actionId?: string;
  actionRevision?: number;
  administrationAuthorityId?: string;
  administrationRevision?: number;
  vessel?: VesselHandoff;
}

function nextVessel(previous: WorkflowSelection | undefined, context: VesselWorkflowContext): VesselHandoff {
  return { context, revision: (previous?.vessel?.revision ?? 0) + 1 };
}

export function Application(): ReactElement {
  const [selection, setSelection] = useState<WorkflowSelection | undefined>();
  const previousAccount = useRef<string | undefined>(undefined);
  const clearOtherAccount = useCallback((accountId: string | undefined): void => {
    const previous = previousAccount.current;
    previousAccount.current = accountId;
    setSelection((current) => current?.accountId === accountId ? current : undefined);
    if (previous !== undefined && previous !== accountId && routeFromPathname(window.location.pathname).authoringEdit !== undefined) {
      navigateToTopic('authoring');
    }
  }, []);
  const openAction = (context: TopicContext, actionId: string): void => {
    const { accountId } = context;
    if (accountId === undefined) return;
    setSelection((current) => {
      const previous = current?.accountId === accountId ? current : undefined;
      return { ...previous, accountId, actionId, actionRevision: (previous?.actionRevision ?? 0) + 1 };
    });
    context.navigateTopic('activity');
  };
  const openActivityContext = (context: TopicContext, destination: ActivityContext): void => {
    const { accountId } = context;
    if (accountId === undefined) return;
    if (destination.kind === 'administration') {
      setSelection((current) => {
        const previous = current?.accountId === accountId ? current : undefined;
        return {
          ...previous,
          accountId,
          administrationAuthorityId: destination.authorityId,
          administrationRevision: (previous?.administrationRevision ?? 0) + 1
        };
      });
      context.navigateTopic('administration');
      return;
    }
    const handoff: VesselWorkflowContext | undefined = destination.kind === 'vessel'
      ? { accountId, vesselId: destination.vesselId }
      : destination.kind === 'journey'
        ? { accountId, vesselId: destination.vesselId, routePlanId: destination.routePlanId }
        : (destination.vesselId === undefined
          ? undefined
          : {
              accountId,
              vesselId: destination.vesselId,
              ...(destination.authorityId === undefined ? {} : { authorityId: destination.authorityId }),
              jobId: destination.jobId
            });
    if (handoff === undefined) return;
    setSelection((current) => {
      const previous = current?.accountId === accountId ? current : undefined;
      return { ...previous, accountId, vessel: nextVessel(previous, handoff) };
    });
    context.navigateTopic('logistics');
  };
  const replaceVessel = (context: TopicContext, handoff: VesselWorkflowContext): void => {
    const { accountId } = context;
    if (accountId === undefined || handoff.accountId !== accountId) return;
    setSelection((current) => {
      const previous = current?.accountId === accountId ? current : undefined;
      return { ...previous, accountId, vessel: nextVessel(previous, handoff) };
    });
  };
  const openExplore = (context: TopicContext, handoff: VesselWorkflowContext): void => {
    replaceVessel(context, handoff);
    context.navigateTopic('explore');
  };
  return (
    <AppShell onAccountChange={clearOtherAccount} renderTopic={(topic, context) => {
      const current = selection?.accountId === context.accountId ? selection : undefined;
      const vessel = current?.vessel?.context;
      const vesselRevision = current?.vessel?.revision;
      if (topic === 'connections') return <ConnectionsWorkspace {...context} />;
      if (topic === 'explore') return (
        <ExploreWorkspace
          {...context}
          {...(vessel === undefined ? {} : { context: vessel })}
          {...(vesselRevision === undefined ? {} : { selectionRevision: vesselRevision })}
          onOpenLogistics={(handoff) => { replaceVessel(context, handoff); context.navigateTopic('logistics'); }}
          onOpenProduction={(handoff) => { replaceVessel(context, handoff); context.navigateTopic('logistics'); }}
        />
      );
      if (topic === 'logistics') return (
        <LogisticsWorkspace
          {...context}
          {...(vessel === undefined ? {} : { context: vessel })}
          {...(vesselRevision === undefined ? {} : { selectionRevision: vesselRevision })}
          onContextChange={(handoff) => replaceVessel(context, handoff)}
          onOpenExplore={(handoff) => openExplore(context, handoff)}
          onOpenAction={(actionId) => openAction(context, actionId)}
        />
      );
      if (topic === 'authoring') return (
        <AuthoringWorkspace
          {...context}
          {...(context.route.authoringEdit === undefined ? {} : { authoringEdit: context.route.authoringEdit })}
          onOpenAction={(actionId) => openAction(context, actionId)}
          onCloseEdit={() => context.navigateTopic('authoring')}
        />
      );
      if (topic === 'activity') return (
        <ActivityWorkspace
          {...context}
          {...(current?.actionId === undefined ? {} : { actionId: current.actionId })}
          {...(current?.actionRevision === undefined ? {} : { selectionRevision: current.actionRevision })}
          onOpenContext={(destination) => openActivityContext(context, destination)}
        />
      );
      if (topic === 'administration') return (
        <AdministrationWorkspace
          {...context}
          {...(current?.administrationAuthorityId === undefined ? {} : { authorityId: current.administrationAuthorityId })}
          {...(current?.administrationRevision === undefined ? {} : { selectionRevision: current.administrationRevision })}
          onOpenAction={(actionId) => openAction(context, actionId)}
        />
      );
      return undefined;
    }} />
  );
}
