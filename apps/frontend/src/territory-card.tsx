import type { ReactElement } from 'react';
import styles from './cards.module.css';

export interface TerritoryCardProps {
  name?: string;
  handle?: string;
  onPress?: () => void;
}

export function TerritoryCard(props: TerritoryCardProps): ReactElement {
  const name = props.name?.trim();
  const handle = props.handle?.trim();
  const label = name || handle || 'Unnamed territory';
  const content = (
    <>
      <span className={styles.name}>{label}</span>
      {name !== undefined && handle !== undefined ? <span className={styles.handle}>{handle}</span> : null}
    </>
  );
  return props.onPress === undefined
    ? <article className={styles.card}>{content}</article>
    : <button type="button" className={`${styles.card} ${styles.interactive}`} onClick={props.onPress}>{content}</button>;
}
