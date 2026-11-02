import type { ReactElement } from 'react';
import type { LibraryMedia } from '@fctp/client-sdk';
import { CardIdentities, CardMedia } from './card-fields';
import cardStyles from './cards.module.css';

export interface AssetCardProps {
  name?: string;
  creator?: readonly string[];
  holder?: string;
  media?: readonly LibraryMedia[];
  status?: 'draft' | 'up-to-date' | 'unpublished changes';
  onPress?: () => void;
}

export function AssetCard(props: AssetCardProps): ReactElement {
  const title = props.name?.trim() || 'Unnamed asset';
  const content = (
    <>
      <span className={cardStyles.name}>{title}</span>
      {props.status === undefined ? null : <span className={cardStyles.status}>{props.status}</span>}
      <CardIdentities
        {...(props.creator === undefined ? {} : { creator: props.creator })}
        {...(props.holder === undefined ? {} : { holder: props.holder })}
      />
      <CardMedia
        {...(props.media === undefined ? {} : { media: props.media })}
        title={title}
      />
    </>
  );
  const label = props.status === undefined ? undefined : `${title} ${props.status}`;
  return props.onPress === undefined
    ? <article className={cardStyles.card}>{content}</article>
    : <button type="button" aria-label={label} className={`${cardStyles.card} ${cardStyles.interactive}`} onClick={props.onPress}>{content}</button>;
}
