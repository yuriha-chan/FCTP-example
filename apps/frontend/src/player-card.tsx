import type { ReactElement } from 'react';
import styles from './cards.module.css';

export interface PlayerCardProps {
  handle: string;
}

export function PlayerCard(props: PlayerCardProps): ReactElement {
  const handle = props.handle?.trim();
  return (
    <article className={styles.card}>
      <span className={styles.name}>{handle || 'Unnamed player'}</span>
    </article>
  );
}
