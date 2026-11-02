import { useSyncExternalStore } from 'react';

export type TopicId = 'connections' | 'explore' | 'logistics' | 'authoring' | 'activity' | 'administration';

export type AuthoringEditKind = 'asset' | 'variety';

export interface AuthoringEditRoute {
  kind: AuthoringEditKind;
  draftId: string;
}

export interface AppRoute {
  topic: TopicId;
  authoringEdit?: AuthoringEditRoute;
}

export const TOPIC_PATHS: Readonly<Record<TopicId, string>> = {
  connections: '/connections',
  explore: '/explore',
  logistics: '/logistics',
  authoring: '/authoring',
  activity: '/activity',
  administration: '/administration'
};

const TOPIC_BY_PATH = new Map<string, TopicId>(
  (Object.entries(TOPIC_PATHS) as Array<[TopicId, string]>).map(([topic, path]) => [path, topic])
);
const AUTHORING_EDIT_PATTERN = /^\/authoring\/(assets|varieties)\/edit\/([^/]+)$/;
const ROUTE_CHANGE_EVENT = 'fctp-route-change';

function normalizedPathname(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

export function authoringEditPath(edit: AuthoringEditRoute): string {
  return `/authoring/${edit.kind === 'asset' ? 'assets' : 'varieties'}/edit/${encodeURIComponent(edit.draftId)}`;
}

export function routeFromPathname(pathname: string): AppRoute {
  const normalized = normalizedPathname(pathname);
  if (normalized === '/' || normalized === '/index.html') return { topic: 'connections' };
  const match = AUTHORING_EDIT_PATTERN.exec(normalized);
  if (match) {
    try {
      return {
        topic: 'authoring',
        authoringEdit: {
          kind: match[1] === 'assets' ? 'asset' : 'variety',
          draftId: decodeURIComponent(match[2]!)
        }
      };
    } catch {
      return { topic: 'connections' };
    }
  }
  return { topic: TOPIC_BY_PATH.get(normalized) ?? 'connections' };
}

export function topicFromPathname(pathname: string): TopicId {
  return routeFromPathname(pathname).topic;
}

export function canonicalizeRoute(): TopicId {
  const route = routeFromPathname(window.location.pathname);
  const path = route.authoringEdit === undefined ? TOPIC_PATHS[route.topic] : authoringEditPath(route.authoringEdit);
  if (window.location.pathname !== path) {
    window.history.replaceState(window.history.state, '', `${path}${window.location.search}${window.location.hash}`);
  }
  return route.topic;
}

export function navigateToTopic(topic: TopicId): void {
  const path = TOPIC_PATHS[topic];
  if (window.location.pathname !== path) {
    window.history.pushState({ topic }, '', `${path}${window.location.search}${window.location.hash}`);
  }
  window.dispatchEvent(new Event(ROUTE_CHANGE_EVENT));
}

export function navigateToAuthoringEdit(edit: AuthoringEditRoute): void {
  const path = authoringEditPath(edit);
  if (window.location.pathname !== path) {
    window.history.pushState({ topic: 'authoring', authoringEdit: edit }, '', `${path}${window.location.search}${window.location.hash}`);
  }
  window.dispatchEvent(new Event(ROUTE_CHANGE_EVENT));
}

let cachedPath: string | undefined;
let cachedRoute: AppRoute = { topic: 'connections' };

function currentRoute(): AppRoute {
  const path = window.location.pathname;
  if (path !== cachedPath) {
    cachedPath = path;
    cachedRoute = routeFromPathname(path);
  }
  return cachedRoute;
}

function subscribeToRoute(listener: () => void): () => void {
  window.addEventListener('popstate', listener);
  window.addEventListener(ROUTE_CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(ROUTE_CHANGE_EVENT, listener);
  };
}

export function useRoute(): AppRoute {
  return useSyncExternalStore(
    subscribeToRoute,
    currentRoute,
    () => cachedRoute
  );
}

export function useRouteTopic(): TopicId {
  return useRoute().topic;
}
