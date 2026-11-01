import { Fragment } from 'react';
import type { ReactElement } from 'react';
import type { LibraryMedia } from '@fctp/client-sdk';
import { HandleLabel } from './handle-label';
import cardStyles from './cards.module.css';
import styles from './asset-card.module.css';

export interface AssetCardProps {
  name?: string;
  creator?: readonly string[];
  holder?: string;
  media?: readonly LibraryMedia[];
  onPress?: () => void;
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

function distinct(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function AssetCard(props: AssetCardProps): ReactElement {
  const title = props.name?.trim() || 'Unnamed asset';
  const creators = distinct(props.creator ?? []);
  const media = props.media ?? [];
  const content = (
    <>
      <span className={cardStyles.name}>{title}</span>
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
      {media.length === 0 ? null : (
        <span className={styles.media}>
          {media.map((item, index) => (
            <Fragment key={`${item.url ?? item.mediaType ?? 'media'}:${index}`}>{mediaContent(item, title)}</Fragment>
          ))}
        </span>
      )}
    </>
  );
  return props.onPress === undefined
    ? <article className={cardStyles.card}>{content}</article>
    : <button type="button" className={`${cardStyles.card} ${cardStyles.interactive}`} onClick={props.onPress}>{content}</button>;
}
