import type { ReactElement } from 'react';
import styles from './cards.module.css';

export interface PortCardProps {
  name?: string;
}

export function PortCard(props: PortCardProps): ReactElement {
  const name = props.name?.trim();
  return (
    <article className={styles.card}>
      <span className={styles.name}>{name || 'Unnamed port'}</span>
    </article>
  );
}
