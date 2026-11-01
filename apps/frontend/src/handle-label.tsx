import type { ReactElement } from 'react';
import { identityDisplay } from './identity-display.js';
import styles from './identity-display.module.css';

export type IdentityRole = 'player' | 'territory' | 'registry' | 'home';

export interface HandleLabelProps {
  actorId?: string;
  handle?: string;
  name?: string;
  role?: IdentityRole;
  onPress?: () => void;
}

export function HandleLabel(props: HandleLabelProps): ReactElement {
  const identity = props.actorId === undefined ? undefined : identityDisplay.get(props.actorId);
  const handle = props.handle?.trim() || identity?.handle;
  const name = props.name?.trim() || identity?.name;
  const roleClass = props.role === undefined ? undefined : styles[props.role];
  if (handle) {
    const className = [styles.handle, roleClass].filter(Boolean).join(' ');
    return props.onPress === undefined
      ? <span className={className}>{handle}</span>
      : <button type="button" className={`${className} ${styles.handleButton}`} onClick={props.onPress}>{handle}</button>;
  }
  if (name) {
    return <span className={styles.name}>{name} <span className={styles.unknown}>handle unavailable</span></span>;
  }
  return <span className={styles.unknown}>Handle unavailable</span>;
}
