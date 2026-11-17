import { Material, materialChunkBytes, materialDigestPattern, materialMaxBytes, MaterialSource } from '../core/materials';
import { isObject } from '../core/orders';
import { workspaceRequest } from './workspace';

const manifestKey = 'dispatch-s5-material-outbox';
const localId = /^order-[0-9]+-[0-9]+-[a-z0-9]{1,6}$/;
const draftIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function filePath({ requestId, draftId }: MaterialSource) {
  if (!localId.test(requestId) || !draftIdPattern.test(draftId)) throw new Error('本机材料编号无效');
  return `${wx.env.USER_DATA_PATH}/dispatch-material-${draftId}-${requestId}`;
}

export function sameMaterial(left: MaterialSource, right: MaterialSource) {
  return left.requestId === right.requestId && left.draftId === right.draftId && left.revision === right.revision
    && left.size === right.size && left.digest === right.digest;
}

export function stagedMaterials(): MaterialSource[] {
  const data: unknown = wx.getStorageSync(manifestKey);
  if (data === '') return [];
  if (!Array.isArray(data) || !data.every(entry => isObject(entry) && typeof entry.requestId === 'string'
      && localId.test(entry.requestId) && typeof entry.draftId === 'string' && draftIdPattern.test(entry.draftId)
      && typeof entry.name === 'string'
      && typeof entry.revision === 'number' && typeof entry.size === 'number'
      && typeof entry.digest === 'string' && materialDigestPattern.test(entry.digest))) {
    throw new Error('本机材料记录读取失败');
  }
  return data as MaterialSource[];
}

export function chooseMaterial(album: boolean): Promise<{ path: string; name: string } | null> {
  return new Promise((resolve, reject) => {
    const fail = ({ errMsg }: { errMsg: string }) => {
      if (/cancel/i.test(errMsg)) resolve(null);
      else reject(new Error('无法选择文件，请检查权限后重试'));
    };
    if (album) {
      wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album'], sizeType: ['original'],
        success: ({ tempFiles }) => {
          const image = tempFiles[0];
          const suffix = /\.[a-z0-9]+$/i.exec(image?.tempFilePath ?? '')?.[0];
          resolve(image ? { path: image.tempFilePath, name: `相册图片${suffix ?? '.jpg'}` } : null);
        }, fail });
      return;
    }
    wx.chooseMessageFile({ count: 1, type: 'all', success: ({ tempFiles }) => {
      const file = tempFiles[0];
      resolve(file ? { path: file.path, name: file.name } : null);
    }, fail });
  });
}

export function materialInfo(path: string) {
  return new Promise<Pick<MaterialSource, 'size' | 'digest'>>((resolve, reject) => {
    wx.getFileSystemManager().getFileInfo({ filePath: path, digestAlgorithm: 'sha256', success: ({ size, digest }) => {
      const normalized = digest?.toLowerCase();
      if (size < 1 || size > materialMaxBytes || !materialDigestPattern.test(normalized ?? '')) {
        reject(new Error('文件大小或校验信息无效，请选择不超过 10 MB 的图片'));
        return;
      }
      resolve({ size, digest: normalized });
    }, fail: () => reject(new Error('无法读取文件，请重新选择原文件')) });
  });
}

export async function stageMaterial(source: MaterialSource, selectedPath: string) {
  const name = source.name.trim();
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f/\\]/.test(name)) {
    throw new Error('文件名无效，请重新选择');
  }
  const previous = stagedMaterials();
  const path = filePath(source);
  await new Promise<void>((resolve, reject) => wx.getFileSystemManager().copyFile({
    srcPath: selectedPath, destPath: path, success: () => resolve(),
    fail: () => reject(new Error('本机文件保存失败，请检查小程序存储空间后重试')),
  }));
  try {
    const { requestId, draftId, revision, size, digest } = source;
    wx.setStorageSync(manifestKey, [...previous.filter(entry => !sameMaterial(entry, source)),
      { requestId, draftId, revision, name, size, digest }]);
  } catch {
    if (!previous.some(entry => sameMaterial(entry, source))) {
      wx.getFileSystemManager().unlink({ filePath: path });
    }
    throw new Error('本机上传进度保存失败，请重试');
  }
}

export function forgetStaged(sources: MaterialSource[]) {
  const previous = stagedMaterials();
  const removed = previous.filter(entry => sources.some(source => sameMaterial(entry, source)));
  if (!removed.length) return;
  wx.setStorageSync(manifestKey, previous.filter(entry => !removed.includes(entry)));
  for (const entry of removed) wx.getFileSystemManager().unlink({ filePath: filePath(entry) });
}

export function readChunk(material: Material) {
  const length = Math.min(materialChunkBytes, material.size - material.received);
  return new Promise<ArrayBuffer>((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: filePath(material), position: material.received, length,
      success: ({ data }) => {
        if (typeof data === 'string' || data.byteLength !== length) {
          reject(new Error('本机文件不完整，请重新选择原文件'));
          return;
        }
        resolve(data);
      },
      fail: () => reject(new Error('本机原文件无法读取，请重新选择原文件')),
    });
  });
}

export function uploadChunk(material: Material, content: ArrayBuffer, token: string) {
  return workspaceRequest<{ material: Material }>('PUT', `/materials/${material.id}/chunks`, token, content,
    { 'Content-Type': 'application/octet-stream', 'X-Material-Offset': String(material.received) });
}
