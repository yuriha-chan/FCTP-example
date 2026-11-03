import type { ReactElement, ReactNode } from 'react';
import { Button as AriaButton, type ButtonProps } from 'react-aria-components';
import styles from './ui.module.css';

type BadgeTone = 'neutral' | 'accent' | 'warning' | 'danger';

const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: '',
  accent: styles.badgeAccent ?? '',
  warning: styles.badgeWarning ?? '',
  danger: styles.badgeDanger ?? ''
};

/** Small status pill. Always carries text, so colour is never the only signal. */
export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }): ReactElement {
  return <span className={`${styles.badge ?? ''} ${BADGE_TONE[tone]}`.trim()}>{children}</span>;
}

type ButtonVariant = 'secondary' | 'primary' | 'quiet';

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  secondary: '',
  primary: styles.buttonPrimary ?? '',
  quiet: styles.buttonQuiet ?? ''
};

/** react-aria Button with the shared look. Use instead of per-module button classes. */
export function UiButton({ variant = 'secondary', className, ...rest }: Omit<ButtonProps, 'className'> & {
  variant?: ButtonVariant;
  className?: string;
}): ReactElement {
  const classes = [styles.button ?? '', BUTTON_VARIANT[variant], className ?? ''].filter(Boolean).join(' ');
  return <AriaButton {...rest} className={classes} />;
}

export interface EmptyStateProps {
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}

/** Explains why a view is empty and what to do next, instead of placeholder text. */
export function EmptyState({ title, children, actions }: EmptyStateProps): ReactElement {
  return (
    <section className={styles.empty} aria-label={title}>
      <h2 className={styles.emptyTitle}>{title}</h2>
      {children === undefined ? null : <p className={styles.emptyBody}>{children}</p>}
      {actions === undefined ? null : <div className={styles.emptyActions}>{actions}</div>}
    </section>
  );
}

/** Label/value pairs as a real description list; stacks on narrow screens. */
export function KeyValueList({ items }: { items: ReadonlyArray<readonly [label: string, value: ReactNode]> }): ReactElement {
  return (
    <dl className={styles.kv}>
      {items.map(([label, value]) => (
        <div key={label} style={{ display: 'contents' }}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Raw protocol data, collapsed by default so it never competes with the readable view. */
export function TechnicalDetails({ summary = 'Technical details', value }: { summary?: string; value: unknown }): ReactElement {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
  return (
    <details className={styles.technical}>
      <summary>{summary}</summary>
      <pre>{text}</pre>
    </details>
  );
}
