import type { ReactElement } from 'react';
import type { LibraryMedia } from '@fctp/client-sdk';
import { CardIdentities, CardMedia } from './card-fields';
import cardStyles from './cards.module.css';

export interface AssetCardProps {
  name?: string;
  creator?: readonly string[];
  holder?: string;
  media?: readonly LibraryMedia[];
  onPress?: () => void;
}

export function AssetCard(props: AssetCardProps): ReactElement {
  const title = props.name?.trim() || 'Unnamed asset';
  const content = (
    <>
      <span className={cardStyles.name}>{title}</span>
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
  return props.onPress === undefined
    ? <article className={cardStyles.card}>{content}</article>
    : <button type="button" className={`${cardStyles.card} ${cardStyles.interactive}`} onClick={props.onPress}>{content}</button>;
}
