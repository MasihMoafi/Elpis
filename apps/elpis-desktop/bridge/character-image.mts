import sharp from 'sharp';
import { imageMime } from './attachments.mts';
import { BridgeError } from './validate.mts';
import { CHARACTER_LIMITS } from '../lib/custom-character-types.mts';

/** Decode before storing: reject active formats and decompression bombs, strip metadata, keep a small static PNG. */
export async function characterImage(data: unknown): Promise<Buffer> {
  if (typeof data !== 'string') throw new BridgeError('Choose a PNG, JPEG or WebP portrait.');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  if (!match) throw new BridgeError('Portrait must be a PNG, JPEG or WebP image.');
  const encoded = match[2]!;
  if (encoded.length > Math.ceil(CHARACTER_LIMITS.imageBytes / 3) * 4) throw new BridgeError('Portrait is too large (maximum 4 MiB).', 413);
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > CHARACTER_LIMITS.imageBytes || bytes.toString('base64') !== encoded || imageMime(bytes) !== match[1]) throw new BridgeError('Portrait image data is invalid.');
  try {
    const decoder = sharp(bytes, { limitInputPixels: 4096 * 4096, failOn: 'warning' });
    const metadata = await decoder.metadata();
    if ((metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height) throw new Error('Use a static image.');
    const png = await decoder.rotate().resize(256, 256, { fit: 'contain', kernel: 'nearest', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    if (png.length > CHARACTER_LIMITS.portraitBytes) throw new Error('Image is too large after decoding.');
    return png;
  } catch { throw new BridgeError('Portrait image could not be decoded. Use a static image of at most 4096 × 4096 pixels.'); }
}

export const portraitDataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
