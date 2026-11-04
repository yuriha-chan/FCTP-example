import type { ReactElement } from 'react';
import styles from './cards.module.css';

export interface HomeCardProps {
  name?: string;
  handle?: string;
  onPress?: () => void;
}

export function HomeCard(props: HomeCardProps): ReactElement {
  const name = props.name?.trim();
  const handle = props.handle?.trim();
  const content = (
    <>
      <span className={styles.name}>{name || 'Unnamed home'}</span>
      <span className={styles.handle}>{handle || 'handle unavailable'}</span>
    </>
  );
  return props.onPress === undefined
    ? <article className={styles.card}>{content}</article>
    : <button type="button" className={`${styles.card} ${styles.interactive}`} onClick={props.onPress}>{content}</button>;
}
