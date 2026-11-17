export const materialChunkBytes = 256 * 1024;
export const materialMaxBytes = 10 * 1024 * 1024;
export const materialImagePattern = /\.(?:jpe?g|png|webp|heic)$/i;
export const materialDigestPattern = /^[0-9a-f]{64}$/;

export interface MaterialSource {
  requestId: string;
  draftId: string;
  revision: number;
  name: string;
  size: number;
  digest: string;
}

export interface Material extends MaterialSource {
  id: string;
  received: number;
  status: 'uploading' | 'ready';
  draftCurrent: boolean;
  organized: boolean;
}
