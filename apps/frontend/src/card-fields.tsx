import { Fragment } from 'react';
import type { ReactElement } from 'react';
import type { LibraryMedia } from '@fctp/client-sdk';
import { HandleLabel } from './handle-label';
import styles from './cards.module.css';

function distinct(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function CardIdentities(props: {
  creator?: readonly string[];
  holder?: string;
}): ReactElement | null {
  const creators = distinct(props.creator ?? []);
  if (creators.length === 0 && props.holder === undefined) return null;
  return (
    <>
      {creators.length === 0 ? null : (
        <span className={styles.meta}>
          by{' '}
          {creators.map((creator, index) => (
            <Fragment key={creator}>
              {index === 0 ? null : ', '}
              <HandleLabel actorId={creator} />
            </Fragment>
          ))}
        </span>
      )}
      {props.holder === undefined ? null : <span className={styles.meta}>held by <HandleLabel actorId={props.holder} /></span>}
    </>
  );
}

function mediaContent(media: LibraryMedia, title: string): ReactElement {
  const mediaType = typeof media.mediaType === 'string' ? media.mediaType : undefined;
  if (mediaType?.startsWith('image/') === true && typeof media.url === 'string') {
    return <img className={styles.image} src={media.url} alt={`${title} media`} loading="lazy" />;
  }
  if (media.state === 'not-retrieved') return <span className={styles.state}>Media not retrieved</span>;
  if (media.state === 'unavailable') return <span className={styles.state}>Media unavailable</span>;
  if (mediaType?.startsWith('text/') === true && typeof media.value === 'string') {
    return <span className={styles.text}>{media.value}</span>;
  }
  return <span className={styles.state}>Media unavailable</span>;
}

export function CardMedia(props: {
  media?: readonly LibraryMedia[];
  title: string;
}): ReactElement | null {
  const media = props.media ?? [];
  if (media.length === 0) return null;
  return (
    <span className={styles.media}>
      {media.map((item, index) => (
        <Fragment key={`${item.url ?? item.mediaType ?? 'media'}:${index}`}>{mediaContent(item, props.title)}</Fragment>
      ))}
    </span>
  );
}
