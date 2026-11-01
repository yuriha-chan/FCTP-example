import { useSyncExternalStore } from 'react';

export type TopicId = 'connections' | 'explore' | 'logistics' | 'authoring' | 'activity' | 'administration';

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
const ROUTE_CHANGE_EVENT = 'fctp-route-change';

export function topicFromPathname(pathname: string): TopicId {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (normalized === '/' || normalized === '/index.html') return 'connections';
  return TOPIC_BY_PATH.get(normalized) ?? 'connections';
}

export function canonicalizeRoute(): TopicId {
  const topic = topicFromPathname(window.location.pathname);
  const path = TOPIC_PATHS[topic];
  if (window.location.pathname !== path) {
    window.history.replaceState(window.history.state, '', `${path}${window.location.search}${window.location.hash}`);
  }
  return topic;
}

export function navigateToTopic(topic: TopicId): void {
  const path = TOPIC_PATHS[topic];
  if (window.location.pathname !== path) {
    window.history.pushState({ topic }, '', `${path}${window.location.search}${window.location.hash}`);
  }
  window.dispatchEvent(new Event(ROUTE_CHANGE_EVENT));
}

function subscribeToRoute(listener: () => void): () => void {
  window.addEventListener('popstate', listener);
  window.addEventListener(ROUTE_CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(ROUTE_CHANGE_EVENT, listener);
  };
}

export function useRouteTopic(): TopicId {
  return useSyncExternalStore(
    subscribeToRoute,
    () => topicFromPathname(window.location.pathname),
    () => 'connections'
  );
}
