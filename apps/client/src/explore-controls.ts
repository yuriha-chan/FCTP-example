import type { ExploreConnectionRecord, ExplorePlaceDetailData, ExplorePlaceRecord, ExplorePlacesData, RoutePlanRecord } from '@fctp/client-sdk';
import { createRoutePlan, readExplorePlace, refreshExplorePlaces, type ResourceReaderResponse } from './application-api.js';
import type { ResourceReaderController } from './resource-reader.js';
import { clearExploreRouteSelection, setExploreRouteSelection } from './route-selection.js';

export interface ExploreControlsOptions {
  selectedAccountId: () => string | undefined;
  reader?: ResourceReaderController;
}

interface ExploreQuery {
  accountId?: string;
  vesselId?: string;
}

interface ExploreSelection {
  accountId: string;
  plan: RoutePlanRecord;
  from?: ExplorePlaceRecord;
  to?: ExplorePlaceRecord;
  routeName?: string;
}

function element<T extends HTMLElement>(id: string): T | undefined {
  const found = document.getElementById(id);
  return found instanceof HTMLElement ? found as T : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function displayName(record: { id: string; name?: string }): string {
  return record.name ?? 'Resource';
}

function readable(value: string): string {
  return value.replace(/(?:https?:\/\/|urn:)[^\s,;]+/gi, 'technical reference');
}

function detailsBlock(label: string, content: string): HTMLDetailsElement {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = label;
  const body = document.createElement('pre');
  body.textContent = content;
  details.append(summary, body);
  return details;
}

export interface ExploreControlsController {
  accountChanged(): void;
}

export function setupExploreControls(options: ExploreControlsOptions): ExploreControlsController | undefined {
  const exploreSection = element<HTMLElement>('explore-controls');
  const vesselField = element<HTMLInputElement>('explore-vessel');
  const refreshButton = element<HTMLButtonElement>('explore-refresh');
  const status = element<HTMLElement>('explore-status');
  const placesPanel = element<HTMLElement>('explore-places');
  const detailPanel = element<HTMLElement>('explore-detail');
  const planPanel = element<HTMLElement>('explore-plan');
  const logisticsPanel = element<HTMLElement>('logistics-selection');
  if (!exploreSection || !vesselField || !refreshButton || !status || !placesPanel || !detailPanel || !planPanel || !logisticsPanel) return;

  let current: ExplorePlacesData | undefined;
  let query: ExploreQuery = {};
  let selectedOrigin: string | undefined;
  let selectedDestination: string | undefined;
  let lastSelection: ExploreSelection | undefined;
  let operation = 0;

  const setStatus = (message: string): void => { status.textContent = message; };

  const withBusy = async (action: () => Promise<void>): Promise<void> => {
    document.documentElement.dataset.clientBusy = 'true';
    try {
      await action();
    } catch (error) {
      setStatus(`Explore error: ${errorText(error)}`);
    } finally {
      document.documentElement.dataset.clientBusy = 'false';
    }
  };

  const renderPlaces = (data: ExplorePlacesData): void => {
    placesPanel.replaceChildren();
    if (data.places.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'No retained places. Refresh places to read discovered Territory geography.';
      placesPanel.append(empty);
      return;
    }
    for (const place of data.places) {
      const name = displayName(place);
      const card = document.createElement('article');
      const heading = document.createElement('h3');
      heading.textContent = name;
      const meta = document.createElement('p');
      meta.textContent = place.name ?? place.type ?? 'Place';
      const openButton = document.createElement('button');
      openButton.type = 'button';
      openButton.textContent = `Open ${name}`;
      openButton.addEventListener('click', () => { void withBusy(() => openPlace(place.id)); });
      const originButton = document.createElement('button');
      originButton.type = 'button';
      originButton.textContent = `Select ${name} as route origin`;
      originButton.addEventListener('click', () => { selectedOrigin = place.id; setStatus(`Route origin: ${name}`); });
      const destinationButton = document.createElement('button');
      destinationButton.type = 'button';
      destinationButton.textContent = `Select ${name} as route destination`;
      destinationButton.addEventListener('click', () => { selectedDestination = place.id; setStatus(`Route destination: ${name}`); });
      card.append(heading, meta, openButton, originButton, destinationButton);
      placesPanel.append(card);
    }
    const namedAreas = data.areas.filter((area) => area.name !== undefined);
    if (namedAreas.length > 0) {
      const heading = document.createElement('h4');
      heading.textContent = 'Areas';
      placesPanel.append(heading);
      for (const area of namedAreas) {
        const entry = document.createElement('p');
        entry.textContent = area.name ?? 'Resource';
        placesPanel.append(entry);
      }
    }
  };

  const placeName = (id: string): string => {
    const place = current?.places.find((candidate) => candidate.id === id);
    return place === undefined ? 'Unresolved place' : displayName(place);
  };

  const connectionName = (connection: ExploreConnectionRecord | undefined): string | undefined =>
    connection?.name;

  const renderDetail = (data: ExplorePlaceDetailData): void => {
    detailPanel.replaceChildren();
    const heading = document.createElement('h3');
    heading.textContent = displayName(data.place);
    const authority = document.createElement('p');
    authority.textContent = 'Territory authority';
    const openAuthority = document.createElement('button');
    openAuthority.type = 'button';
    openAuthority.textContent = `Open authority for ${displayName(data.place)}`;
    openAuthority.addEventListener('click', () => { void withBusy(() => openResource(data.place.authorityId, data.place.authorityId)); });
    detailPanel.append(heading, authority, openAuthority);

    const capabilityHeading = document.createElement('h4');
    capabilityHeading.textContent = 'Capabilities and known blockers';
    detailPanel.append(capabilityHeading);
    if (data.capabilities.length === 0) {
      const none = document.createElement('p');
      none.textContent = 'No capability snapshot is retained for this account and vessel.';
      detailPanel.append(none);
    }
    for (const capability of data.capabilities) {
      const summary = document.createElement('p');
      summary.textContent = `${readable(capability.label)} · ${capability.available ? 'Available' : 'Blocked'}${capability.reason === undefined ? '' : `: ${readable(capability.reason)}`}`;
      const effect = document.createElement('p');
      effect.textContent = readable(capability.effect);
      detailPanel.append(summary, effect);
      if (capability.request?.body !== undefined) {
        const inputs = document.createElement('p');
        inputs.textContent = `Inputs: ${readable(JSON.stringify(capability.request.body))}`;
        detailPanel.append(inputs);
      }
      detailPanel.append(detailsBlock('Capability technical details', JSON.stringify(capability, null, 2)));
    }

    const connectionHeading = document.createElement('h4');
    connectionHeading.textContent = 'Connections and onward places';
    detailPanel.append(connectionHeading);
    if (data.connections.length === 0) {
      const none = document.createElement('p');
      none.textContent = 'No explicit retained connections.';
      detailPanel.append(none);
    }
    for (const connection of data.connections) {
      const summary = document.createElement('p');
      summary.textContent = `${connection.name ?? 'Connection'}: ${placeName(connection.from)} → ${placeName(connection.to)}`;
      detailPanel.append(summary, detailsBlock('Connection technical details', JSON.stringify(connection, null, 2)));
      for (const endpoint of connection.endpoints ?? []) {
        if (endpoint.state === 'available' || endpoint.state === 'empty') continue;
        const unresolved = document.createElement('p');
        unresolved.textContent = `Endpoint ${endpoint.state}${endpoint.error === undefined ? '' : `: ${readable(endpoint.error)}`}`;
        detailPanel.append(unresolved);
      }
      const otherId = connection.from === data.place.id ? connection.to : connection.from;
      const other = data.onward.find((candidate) => candidate.id === otherId);
      const onwards = document.createElement('button');
      onwards.type = 'button';
      onwards.textContent = `Open onward ${other === undefined ? placeName(otherId) : displayName(other)}`;
      onwards.addEventListener('click', () => { void withBusy(() => openPlace(otherId)); });
      detailPanel.append(onwards);
    }
    for (const blocker of data.blockers) {
      const message = document.createElement('p');
      message.textContent = `Known blocker: ${readable(blocker.message)}`;
      detailPanel.append(message, detailsBlock('Blocker technical details', JSON.stringify(blocker, null, 2)));
    }
    for (const resource of [...data.areas, ...data.maps, ...data.listings]) {
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = `Read ${resource.name ?? resource.type}`;
      open.addEventListener('click', () => { void withBusy(() => openResource(resource.id, resource.authorityId)); });
      detailPanel.append(open);
    }
  };

  const renderObservations = (observations: ResourceReaderResponse['observations'], panel: HTMLElement): void => {
    for (const observation of Object.values(observations)) {
      const status = document.createElement('p');
      status.textContent = `Observation ${observation.state}${'observedAt' in observation ? ` · ${observation.observedAt}` : ''}${'error' in observation ? ` · ${readable(observation.error ?? '')}` : ''}`;
      panel.append(status, detailsBlock('Observation technical details', JSON.stringify(observation, null, 2)));
    }
  };

  const openPlace = async (placeId: string): Promise<void> => {
    const startedAccount = options.selectedAccountId();
    const startedOperation = operation;
    const response = await readExplorePlace(placeId, query.accountId, query.vesselId);
    if (options.selectedAccountId() !== startedAccount || operation !== startedOperation) return;
    renderDetail(response.data);
    renderObservations(response.observations, detailPanel);
    setStatus(`Retained detail for ${displayName(response.data.place)}.`);
  };

  const openResource = async (resourceId: string, authorityId?: string): Promise<void> => {
    if (!options.reader) return;
    await options.reader.open(resourceId, authorityId);
    setStatus('Resource reader opened.');
  };

  const renderPlan = (plan: RoutePlanRecord): void => {
    planPanel.replaceChildren();
    const route = plan.legs[0] === undefined ? undefined : current?.connections.find((connection) => connection.id === plan.legs[0]!.routeId);
    const routeName = connectionName(route);
    const heading = document.createElement('h3');
    heading.textContent = routeName ?? 'Route plan';
    const endpoints = document.createElement('p');
    endpoints.textContent = `${placeName(plan.from)} → ${placeName(plan.to)}`;
    planPanel.append(heading, endpoints);
    for (const blocker of plan.blockers) {
      const message = document.createElement('p');
      message.textContent = `Known blocker: ${readable(blocker.message)}`;
      planPanel.append(message);
    }
    planPanel.append(detailsBlock('Route technical details', JSON.stringify(plan, null, 2)));
    const continueButton = document.createElement('button');
    continueButton.type = 'button';
    continueButton.textContent = 'Continue to Logistics & Production';
    continueButton.addEventListener('click', () => {
      lastSelection = {
        accountId: plan.accountId,
        plan,
        ...(current?.places.find((place) => place.id === plan.from) === undefined ? {} : { from: current.places.find((place) => place.id === plan.from)! }),
        ...(current?.places.find((place) => place.id === plan.to) === undefined ? {} : { to: current.places.find((place) => place.id === plan.to)! }),
        ...(routeName === undefined ? {} : { routeName })
      };
      setExploreRouteSelection({ accountId: plan.accountId, plan });
      renderLogistics();
      setStatus('Selection carried to Logistics & Production.');
    });
    planPanel.append(continueButton);
  };

  const renderLogistics = (): void => {
    logisticsPanel.replaceChildren();
    if (lastSelection === undefined) {
      const none = document.createElement('p');
      none.textContent = 'No route selection yet. Save a route plan in Explore, then continue here.';
      logisticsPanel.append(none);
      return;
    }
    const heading = document.createElement('h3');
    heading.textContent = `Selected route ${lastSelection.routeName ?? 'Route plan'}`;
    const endpoints = document.createElement('p');
    endpoints.textContent = `${placeName(lastSelection.plan.from)} → ${placeName(lastSelection.plan.to)}`;
    const detail = {
      accountId: lastSelection.accountId,
      planId: lastSelection.plan.id,
      from: lastSelection.plan.from,
      to: lastSelection.plan.to,
      routeName: lastSelection.routeName ?? null,
      legs: lastSelection.plan.legs,
      blockers: lastSelection.plan.blockers
    };
    logisticsPanel.append(heading, endpoints, detailsBlock('Selection technical details', JSON.stringify(detail, null, 2)));
  };

  refreshButton.addEventListener('click', () => {
    void withBusy(async () => {
      const startedAccount = options.selectedAccountId();
      const startedOperation = operation;
      const vesselId = vesselField.value.trim();
      const nextQuery: ExploreQuery = {
        ...(startedAccount === undefined ? {} : { accountId: startedAccount }),
        ...(vesselId ? { vesselId } : {})
      };
      const response = await refreshExplorePlaces(nextQuery);
      if (options.selectedAccountId() !== startedAccount || operation !== startedOperation) return;
      query = nextQuery;
      current = response.data;
      selectedOrigin = undefined;
      selectedDestination = undefined;
      detailPanel.replaceChildren();
      planPanel.replaceChildren();
      renderPlaces(response.data);
      renderObservations(response.observations, placesPanel);
      setStatus(`Retained ${response.data.places.length} place(s) and ${response.data.connections.length} explicit connection(s).`);
    });
  });

  const saveButton = element<HTMLButtonElement>('explore-save-route');
  saveButton?.addEventListener('click', () => {
    void withBusy(async () => {
      const accountId = options.selectedAccountId();
      const startedOperation = operation;
      if (accountId === undefined) {
        setStatus('Select an account before saving a route plan.');
        return;
      }
      if (selectedOrigin === undefined || selectedDestination === undefined) {
        setStatus('Select a route origin and destination before saving.');
        return;
      }
      const response = await createRoutePlan({ accountId, from: selectedOrigin, to: selectedDestination });
      if (options.selectedAccountId() !== accountId || operation !== startedOperation) return;
      renderPlan(response.data.plan);
      setStatus('Saved directed route plan.');
    });
  });

  renderLogistics();
  return {
    accountChanged(): void {
      operation += 1;
      current = undefined;
      query = {};
      selectedOrigin = undefined;
      selectedDestination = undefined;
      lastSelection = undefined;
      clearExploreRouteSelection();
      vesselField.value = '';
      placesPanel.replaceChildren();
      detailPanel.replaceChildren();
      planPanel.replaceChildren();
      renderLogistics();
      setStatus('');
    }
  };
}
