import type { ReactElement } from 'react';
import type { LibraryMedia } from '@fctp/client-sdk';
import { CardIdentities, CardMedia } from './card-fields';
import cardStyles from './cards.module.css';

export interface VarietyCardProps {
  name?: string;
  creator?: readonly string[];
  holder?: string;
  mass?: number;
  version?: string;
  media?: readonly LibraryMedia[];
  onPress?: () => void;
}

export function VarietyCard(props: VarietyCardProps): ReactElement {
  const title = props.name?.trim() || 'Unnamed variety';
  const content = (
    <>
      <span className={cardStyles.name}>{title}</span>
      <CardIdentities
        {...(props.creator === undefined ? {} : { creator: props.creator })}
        {...(props.holder === undefined ? {} : { holder: props.holder })}
      />
      {props.mass === undefined && props.version === undefined ? null : (
        <span className={cardStyles.meta}>
          {props.mass === undefined ? null : `Mass ${props.mass}`}
          {props.mass === undefined || props.version === undefined ? null : ' · '}
          {props.version === undefined ? null : `Version ${props.version}`}
        </span>
      )}
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
