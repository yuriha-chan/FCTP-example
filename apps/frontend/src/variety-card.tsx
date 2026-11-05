import { Fragment } from 'react';
import type { ReactElement } from 'react';
import type { LibraryMedia } from '@fctp/client-sdk';
import { CardMedia } from './card-fields';
import { HandleLabel } from './handle-label';
import styles from './variety-card.module.css';

export interface VarietyCardProps {
  name?: string;
  creator?: readonly string[];
  holder?: string;
  mass?: number;
  version?: string;
  media?: readonly LibraryMedia[];
  status?: 'draft' | 'up-to-date' | 'unpublished changes';
  onPress?: () => void;
  production?: readonly unknown[];
  referenceNames?: Readonly<Record<string, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function distinctStrings(values: readonly string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function isImageMedia(media: LibraryMedia): boolean {
  return typeof media.mediaType === 'string' && media.mediaType.startsWith('image/');
}

function recipeEntries(production: readonly unknown[] | undefined): Record<string, unknown>[] {
  if (!Array.isArray(production)) return [];
  return production.filter((entry): entry is Record<string, unknown> =>
    isRecord(entry) && (entry.type === 'mine' || entry.type === 'manufacture'));
}

function referenceName(
  ingredient: Record<string, unknown>,
  referenceNames: Readonly<Record<string, string>> | undefined
): string {
  const variety = typeof ingredient.variety === 'string' ? ingredient.variety : undefined;
  const name = variety === undefined ? undefined : referenceNames?.[variety];
  return typeof name === 'string' && name.trim().length > 0 ? name : 'Unknown ingredient';
}

function IngredientChip(props: {
  ingredient: Record<string, unknown>;
  referenceNames: Readonly<Record<string, string>> | undefined;
}): ReactElement {
  const { ingredient, referenceNames } = props;
  const name = referenceName(ingredient, referenceNames);
  const showCount = isCount(ingredient.count);
  return <span className={styles.ingredient}>{showCount ? `${name} × ${ingredient.count}` : name}</span>;
}

function RecipeYields(props: { entry: Record<string, unknown> }): ReactElement | null {
  const values = Array.isArray(props.entry.yield) ? props.entry.yield : [];
  const yields = values.filter((value): value is Record<string, unknown> =>
    isRecord(value) && isFiniteNumber(value.probability) && isCount(value.count));
  if (yields.length === 0) return null;
  return (
    <div className={styles.yields}>
      {yields.map((value, index) => (
        <span key={index} className={styles.yield}>{`Yield ${value.count} · weight ${value.probability}`}</span>
      ))}
    </div>
  );
}

function Recipe(props: {
  entry: Record<string, unknown>;
  referenceNames: Readonly<Record<string, string>> | undefined;
}): ReactElement {
  const { entry, referenceNames } = props;
  const ingredients = Array.isArray(entry.ingredients) ? entry.ingredients.filter(isRecord) : [];
  return (
    <div className={styles.recipe}>
      <strong>{entry.type === 'manufacture' ? 'Manufactured recipe' : 'Mined recipe'}</strong>
      {ingredients.length === 0 ? null : (
        <div className={styles.ingredients}>
          {ingredients.map((ingredient, index) => (
            <IngredientChip key={index} ingredient={ingredient} referenceNames={referenceNames} />
          ))}
        </div>
      )}
      <RecipeYields entry={entry} />
    </div>
  );
}

export function VarietyCard(props: VarietyCardProps): ReactElement {
  const title = props.name?.trim() || 'Unnamed variety';
  const media = props.media ?? [];
  const artwork = media.filter(isImageMedia);
  const lore = media.filter((item) => !isImageMedia(item));
  const recipes = recipeEntries(props.production);
  const hasManufacture = recipes.some((entry) => entry.type === 'manufacture');
  const hasMine = recipes.some((entry) => entry.type === 'mine');
  const head = ['Item', ...(hasManufacture ? ['Manufactured'] : []), ...(hasMine ? ['Mined'] : [])].join(' - ');
  const creators = distinctStrings(props.creator);
  const holder = typeof props.holder === 'string' && props.holder.trim().length > 0 ? props.holder.trim() : undefined;
  const content = (
    <span className={styles.itemCardInner}>
      <span className={styles.itemCardHead}><span>{head}</span></span>
      {artwork.length === 0 ? null : (
        <span className={styles.itemArt}>
          <CardMedia media={artwork} title={title} />
        </span>
      )}
      <h3 className={styles.itemTitle}>{title}</h3>
      {props.status === undefined ? null : <span className={styles.status}>{props.status}</span>}
      {props.mass === undefined && props.version === undefined ? null : (
        <span className={styles.meta}>
          {props.mass === undefined ? null : `Mass ${props.mass}`}
          {props.mass === undefined || props.version === undefined ? null : ' · '}
          {props.version === undefined ? null : `Version ${props.version}`}
        </span>
      )}
      {lore.length === 0 ? null : (
        <span className={styles.itemLore}>
          <CardMedia media={lore} title={title} />
        </span>
      )}
      {recipes.length === 0 ? null : (
        <span className={styles.recipes}>
          {recipes.map((entry, index) => (
            <Recipe key={index} entry={entry} referenceNames={props.referenceNames} />
          ))}
        </span>
      )}
      {creators.length === 0 && holder === undefined ? null : (
        <span className={styles.productionNote}>
          {creators.length === 0 ? null : (
            <span>
              Asset Creator:{' '}
              {creators.map((creator, index) => (
                <Fragment key={creator}>
                  {index === 0 ? null : ', '}
                  <HandleLabel actorId={creator} />
                </Fragment>
              ))}
            </span>
          )}
          {creators.length === 0 || holder === undefined ? null : <br />}
          {holder === undefined ? null : <span>Variety Manager: <HandleLabel actorId={holder} /></span>}
        </span>
      )}
    </span>
  );
  const label = props.status === undefined ? undefined : `${title} ${props.status}`;
  return props.onPress === undefined
    ? <article className={styles.card}>{content}</article>
    : <button type="button" aria-label={label} className={`${styles.card} ${styles.interactive}`} onClick={props.onPress}>{content}</button>;
}
