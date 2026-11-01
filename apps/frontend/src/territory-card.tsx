import type { ReactElement } from 'react';
import styles from './cards.module.css';

export interface TerritoryCardProps {
  name?: string;
}

export function TerritoryCard(props: TerritoryCardProps): ReactElement {
  const name = props.name?.trim();
  return (
    <article className={styles.card}>
      <span className={styles.name}>{name || 'Unnamed territory'}</span>
    </article>
  );
}
