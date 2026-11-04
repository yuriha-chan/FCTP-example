import type { ReactElement } from 'react';
import styles from './cards.module.css';

export interface RegistryCardProps {
  name?: string;
  handle?: string;
  onPress?: () => void;
}

export function RegistryCard(props: RegistryCardProps): ReactElement {
  const name = props.name?.trim();
  const handle = props.handle?.trim();
  const content = (
    <>
      <span className={styles.name}>{name || 'Unnamed registry'}</span>
      <span className={styles.handle}>{handle || 'handle unavailable'}</span>
    </>
  );
  return props.onPress === undefined
    ? <article className={styles.card}>{content}</article>
    : <button type="button" className={`${styles.card} ${styles.interactive}`} onClick={props.onPress}>{content}</button>;
}
