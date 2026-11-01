import type { CSSProperties, ReactElement } from 'react';
import { identityDisplay } from './identity-display.js';
import styles from './object-identifier.module.css';

export interface ObjectIdentifierProps {
  uri: string;
  owner?: string;
  name?: string;
  onPress?: () => void;
}

const segmentColors = ['#1d4ed8', '#6d28d9', '#0e7490', '#b45309', '#15803d', '#be123c'];

function ownerHandle(owner: string | undefined): string | undefined {
  if (owner === undefined) return undefined;
  const trimmed = owner.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('@')) return trimmed;
  return identityDisplay.handle(trimmed);
}

function pathSegments(uri: string): string[] {
  try {
    return new URL(uri).pathname.split('/').filter(Boolean);
  } catch (error) {
    if (error instanceof TypeError) return [];
    throw error;
  }
}

export function ObjectIdentifier(props: ObjectIdentifierProps): ReactElement {
  const handle = ownerHandle(props.owner);
  const label = handle ?? props.name?.trim() ?? 'Unknown owner';
  const segments = pathSegments(props.uri);
  const body = (
    <>
      <span className={handle === undefined ? styles.unknown : styles.handle}>{label}</span>
      {segments.map((segment, index) => (
        <span
          key={`${segment}\u0000${index}`}
          className={styles.segment}
          style={{ '--segment-color': segmentColors[index % segmentColors.length] } as CSSProperties}
        >
          <span className={styles.separator}>/</span>{segment}
        </span>
      ))}
    </>
  );
  return props.onPress === undefined
    ? <span className={styles.identifier}>{body}</span>
    : <button type="button" className={`${styles.identifier} ${styles.interactive}`} onClick={props.onPress}>{body}</button>;
}
