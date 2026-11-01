import type { ReactElement } from 'react';
import styles from './cards.module.css';

export interface VarietyCardProps {
  name?: string;
  onPress?: () => void;
}

export function VarietyCard(props: VarietyCardProps): ReactElement {
  const name = props.name?.trim();
  const content = <span className={styles.name}>{name || 'Unnamed variety'}</span>;
  return props.onPress === undefined
    ? <article className={styles.card}>{content}</article>
    : <button type="button" className={`${styles.card} ${styles.interactive}`} onClick={props.onPress}>{content}</button>;
}
