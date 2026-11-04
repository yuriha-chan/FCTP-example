import { useEffect, useState } from 'react';
import { readDraftImage, type ImageDescriptor } from './application-api';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function isImageMediaType(value: unknown): value is string {
  return typeof value === 'string' && IMAGE_TYPES.has(value);
}

export interface DraftImagePreview extends ImageDescriptor {
  index: number;
  src?: string;
  error?: string;
}

function imageDescriptors(media: unknown): DraftImagePreview[] {
  if (!Array.isArray(media)) return [];
  return media.flatMap((entry: unknown, index) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const descriptor = entry as Record<string, unknown>;
    return typeof descriptor.url === 'string' && isImageMediaType(descriptor.mediaType)
      ? [{ index, url: descriptor.url, mediaType: descriptor.mediaType }]
      : [];
  });
}

export function useDraftImagePreviews(accountId: string | undefined, draftId: string | undefined, media: unknown): DraftImagePreview[] {
  const descriptors = imageDescriptors(media);
  const scope = JSON.stringify([accountId, draftId, descriptors]);
  const [preview, setPreview] = useState<{ scope: string; images: DraftImagePreview[] }>();

  useEffect(() => {
    let active = true;
    const objectUrls: string[] = [];
    const [account, draft, images] = JSON.parse(scope) as [string | null, string | null, DraftImagePreview[]];
    if (account === null || draft === null || images.length === 0) return;
    setPreview({ scope, images });
    for (const descriptor of images) {
      void readDraftImage(draft, { accountId: account, url: descriptor.url }).then((response) => {
        if (!active) return;
        if (response.mediaType !== descriptor.mediaType || typeof response.data !== 'string' || !response.data) {
          throw new Error('The server returned an unexpected image preview.');
        }
        const binary = atob(response.data);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        const src = URL.createObjectURL(new Blob([bytes], { type: response.mediaType }));
        objectUrls.push(src);
        setPreview((current) => current?.scope === scope ? {
          scope,
          images: current.images.map((image) => image.index === descriptor.index ? { ...image, src } : image)
        } : current);
      }).catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : 'Image preview unavailable.';
        setPreview((current) => current?.scope === scope ? {
          scope,
          images: current.images.map((image) => image.index === descriptor.index ? { ...image, error: message } : image)
        } : current);
      });
    }
    return () => {
      active = false;
      for (const url of objectUrls) URL.revokeObjectURL(url);
    };
  }, [scope]);

  return preview?.scope === scope ? preview.images : descriptors;
}
