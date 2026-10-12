import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { StoreError } from './store.js';
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export interface ImageInfo {
  id: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
}
export async function validateImage(data: Buffer) {
  if (!data.length || data.length > MAX_IMAGE_BYTES)
    throw new StoreError(400, 'Images must be 5 MiB or smaller.');
  try {
    // libvips may expose only the first APNG frame; reject animation chunks explicitly.
    if (
      data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ) {
      for (let offset = 8; offset + 12 <= data.length;) {
        const length = data.readUInt32BE(offset);
        if (length > data.length - offset - 12)
          throw new Error('Invalid PNG chunk');
        const kind = data.toString('ascii', offset + 4, offset + 8);
        if (kind === 'acTL') throw new Error('Animated PNG');
        if (kind === 'IEND') break;
        offset += length + 12;
      }
    }
    const image = sharp(data, {
      limitInputPixels: 4096 * 4096,
      failOn: 'warning',
    });
    const metadata = await image.metadata();
    const mime = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }[
      metadata.format as string
    ];
    if (
      !mime ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > 4096 ||
      metadata.height > 4096 ||
      (metadata.pages ?? 1) > 1
    )
      throw new Error('Unsupported image');
    await image.raw().toBuffer();
    return {
      mime,
      width: metadata.width,
      height: metadata.height,
      bytes: data.length,
      hash: createHash('sha256').update(data).digest('hex'),
    };
  } catch {
    throw new StoreError(
      400,
      'Use a readable static PNG, JPEG or WebP image, at most 4096 px per side.',
    );
  }
}
