import type { ReactElement } from 'react';
import styles from './cards.module.css';

export interface VesselCardProps {
  name?: string;
}

export function VesselCard(props: VesselCardProps): ReactElement {
  const name = props.name?.trim();
  return (
    <article className={styles.card}>
      <span className={styles.name}>{name || 'Unnamed vessel'}</span>
    </article>
  );
}
