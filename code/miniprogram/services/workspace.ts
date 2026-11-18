import type { DeliveryEdits } from '../core/delivery-execution';
import { isObject } from '../core/orders';
import type { Account, Party } from '../core/settlement';
import type { PickingLine, Trip, TripDraft, TripVersion } from '../core/trips';
import { apiOrigin } from './workspace-config';

export interface Workspace {
  draft: TripDraft;
  draftConfirmed: boolean;
  parties: Party[];
  currentTrip: { id: string; version: number; totalCents: number } | null;
}

export interface FormalTrip {
  trip: Trip;
  picking: PickingLine[];
  deliveryEdits?: DeliveryEdits;
  sheets?: Account[];
}

export type TripPreview = Pick<TripVersion, 'customers' | 'totalCents'> & {
  previewId: string;
  draftId: string;
  revision: number;
  choices: (Party | null)[];
};

export class WorkspaceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export function workspaceRequest<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, token = '', data?: object,
  headers?: Record<string, string>, timeout = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${apiOrigin}/v1${path}`, method, data, timeout,
      header: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      success({ statusCode, data: result }) {
        if (statusCode >= 200 && statusCode < 300) { resolve(result as T); return; }
        const payload = isObject(result) ? result : {};
        reject(new WorkspaceError(statusCode, typeof payload.error === 'string' ? payload.error : '',
          typeof payload.message === 'string' ? payload.message : '服务暂时无法处理，请重试'));
      },
      fail() { reject(new Error('无法连接工作区服务，请检查网络后重试')); },
    });
  });
}

export function wechatCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('暂时无法取得微信登录凭证，请重试'));
    wx.login({ timeout: 10_000, success: result => result.code ? resolve(result.code) : fail(), fail });
  });
}

export async function revokeSession(token: string): Promise<void> {
  try { await workspaceRequest('DELETE', '/session', token); }
  catch (error) {
    if (!(error instanceof WorkspaceError && error.status === 401)) throw error;
  }
}
