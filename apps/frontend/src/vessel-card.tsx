import type { ReactElement } from 'react';
import styles from './cards.module.css';

export interface VesselCardProps {
  name?: string;
  onPress?: () => void;
}

export function VesselCard(props: VesselCardProps): ReactElement {
  const name = props.name?.trim();
  const content = <span className={styles.name}>{name || 'Unnamed vessel'}</span>;
  return props.onPress === undefined
    ? <article className={styles.card}>{content}</article>
    : <button type="button" className={`${styles.card} ${styles.interactive}`} onClick={props.onPress}>{content}</button>;
}
