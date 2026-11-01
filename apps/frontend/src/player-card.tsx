import type { ReactElement } from 'react';
import styles from './cards.module.css';

export interface PlayerCardProps {
  handle: string;
  onPress?: () => void;
}

export function PlayerCard(props: PlayerCardProps): ReactElement {
  const handle = props.handle?.trim();
  const content = <span className={styles.name}>{handle || 'Unnamed player'}</span>;
  return props.onPress === undefined
    ? <article className={styles.card}>{content}</article>
    : <button type="button" className={`${styles.card} ${styles.interactive}`} onClick={props.onPress}>{content}</button>;
}
