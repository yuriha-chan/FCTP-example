import type { ReactElement } from 'react';
import styles from './cards.module.css';

export interface VarietyCardProps {
  name?: string;
}

export function VarietyCard(props: VarietyCardProps): ReactElement {
  const name = props.name?.trim();
  return (
    <article className={styles.card}>
      <span className={styles.name}>{name || 'Unnamed variety'}</span>
    </article>
  );
}
