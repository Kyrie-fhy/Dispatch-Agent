import { isObject } from '../miniprogram/core/orders';
import { HttpError } from './http-error';

export interface WechatLogin {
  appId: string;
  exchange(code: string): Promise<string>;
}

export function readWechatCode(body: unknown): string {
  if (!isObject(body) || typeof body.code !== 'string' || !/^[!-~]{1,512}$/.test(body.code)) {
    throw new HttpError(400, 'invalid_wechat_request', '请提供微信登录凭证');
  }
  return body.code;
}

export function configuredWechatLogin(
  env: NodeJS.ProcessEnv,
  request = fetch,
): WechatLogin | undefined {
  const appId = env.DISPATCH_WECHAT_APP_ID?.trim();
  const secret = env.DISPATCH_WECHAT_APP_SECRET?.trim();
  if (!appId && !secret) return undefined;
  if (!appId || !/^wx[0-9a-f]{16}$/i.test(appId) || !secret) {
    throw new Error('请在服务端同时设置有效的 DISPATCH_WECHAT_APP_ID 和 DISPATCH_WECHAT_APP_SECRET');
  }

  return {
    appId,
    async exchange(code) {
      const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
      url.search = new URLSearchParams({ appid: appId, secret, js_code: code, grant_type: 'authorization_code' }).toString();
      let data: unknown;
      try {
        const response = await request(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
        if (!response.ok) throw new Error();
        data = await response.json();
      } catch {
        throw new HttpError(502, 'wechat_unavailable', '微信登录暂不可用，请重新尝试');
      }
      if (isObject(data)) {
        const error = String(data.errcode ?? 0);
        if (error === '0' && typeof data.openid === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(data.openid)) {
          return data.openid;
        }
        if (error === '40029' || error === '40163' || error === '40226') {
          throw new HttpError(401, 'wechat_code_rejected', '微信登录凭证不可用，请重新获取');
        }
        if (error === '45011') throw new HttpError(429, 'wechat_rate_limited', '微信登录过于频繁，请稍后重试');
      }
      throw new HttpError(502, 'wechat_unavailable', '微信登录暂不可用，请重新尝试');
    },
  };
}
