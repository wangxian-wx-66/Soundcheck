import { execFile } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const userInterfaces = [
  ['contents', '我的创作', '/api/v1/user/contents'],
  ['followees', '我的关注', '/api/v1/user/followees'],
  ['favlists', '收藏夹', '/api/v1/user/favlists'],
  ['favlist_contents', '收藏内容', '/api/v1/user/favlist_contents'],
  ['collections', '近期收藏', '/api/v1/user/collections'],
].map(([id, name, endpoint]) => ({ id, name, endpoint }));

function keychain(service, account) {
  return new Promise((resolve) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], (error, stdout) => {
      resolve(!error ? stdout.toString().trim() : null);
    });
  });
}

/** 开放平台 HTTP（原生 fetch，替代脚手架的 /usr/bin/curl 子进程——Windows 本地开发与 Sealos 容器一致可用，Dockerfile 无需装 curl）
 *  请求形状与原 curl 版完全一致（headers / body / 超时） */
async function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal });
    const payload = await response.json().catch(() => null);
    if (payload && typeof payload === 'object') return payload;
    throw Object.assign(new Error(`知乎开放平台返回了无法解析的响应（HTTP ${response.status}）`), { code: 'UPSTREAM_BAD_PAYLOAD' });
  } catch (error) {
    if (error?.name === 'AbortError') throw Object.assign(new Error('知乎开放平台请求超时'), { code: 'UPSTREAM_TIMEOUT' });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function safe(value) {
  if (!value || /[\r\n"\\]/.test(value)) throw new Error('凭证格式无效');
  return value;
}

function fingerprint(value) {
  return value ? createHash('sha256').update(value).digest('hex').slice(0, 12) : null;
}

function payloadError(payload, fallback) {
  const data = payload?.data ?? payload?.Data;
  const message = typeof data === 'string' ? data : data?.message || payload?.message || payload?.Message || fallback;
  const error = new Error(String(message).slice(0, 200));
  error.code = payload?.code ?? payload?.Code ?? 'OAUTH_FAILED';
  return error;
}

function cookieId(request) {
  const value = (request.headers.cookie || '').split(';').map((item) => item.trim()).find((item) => item.startsWith('zhihu_hackathon_session='));
  return value ? decodeURIComponent(value.slice(value.indexOf('=') + 1)) : null;
}

function equal(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function firstItem(payload) {
  return Array.isArray(payload?.Data?.Items) ? payload.Data.Items[0] || null : null;
}

function userRequestConfig(accessSecret, oauthToken) {
  return {
    Authorization: `Bearer ${safe(accessSecret)}`,
    'X-OAuth-Token': safe(oauthToken),
    'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
    'Content-Type': 'application/json',
  };
}

/** 登录回访地址校验：仅允许本站相对路径（拒绝协议相对 //host 与换行注入，防开放重定向） */
function isSafeReturnTo(value) {
  return typeof value === 'string' && /^\/(?![/\\])/.test(value) && !/[\r\n]/.test(value);
}

export function createOAuth(config, { appKey: injectedAppKey = '', accessSecret: injectedSecret = '' } = {}) {
  const sessions = new Map();
  const oauthConfig = config.oauth;

  function session(request, response) {
    let id = cookieId(request);
    let current = id ? sessions.get(id) : null;
    if (!current) {
      id = randomBytes(24).toString('base64url');
      current = { id, state: null, token: null, expiresAt: null, profile: null, stateVerified: null, error: null, debug: null, returnTo: null };
      sessions.set(id, current);
      response.setHeader('Set-Cookie', `zhihu_hackathon_session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
    }
    return current;
  }

  async function credentialDetails() {
    // 凭证优先级：DI 注入（单测/特殊部署）> 环境变量 > macOS Keychain；有上层来源时跳过 keychain 探测
    const [keychainAppKey, keychainAccessSecret] = await Promise.all([
      (injectedAppKey || process.env.ZHIHU_OAUTH_APP_KEY) ? null : keychain(oauthConfig.credentialService, oauthConfig.credentialAccount),
      (injectedSecret || process.env.ZHIHU_ACCESS_SECRET) ? null : keychain('zhihu-cli', 'access-secret'),
    ]);
    const appKey = injectedAppKey || process.env.ZHIHU_OAUTH_APP_KEY || keychainAppKey || '';
    const accessSecret = injectedSecret || process.env.ZHIHU_ACCESS_SECRET || keychainAccessSecret || '';
    return {
      appKey,
      accessSecret,
      diagnostics: {
        appKey: {
          source: injectedAppKey ? 'di:注入' : process.env.ZHIHU_OAUTH_APP_KEY ? 'env:ZHIHU_OAUTH_APP_KEY' : appKey ? 'macOS Keychain' : 'missing',
          configured: Boolean(appKey),
          length: appKey.length,
          sha256Prefix: fingerprint(appKey),
        },
        accessSecret: {
          source: injectedSecret ? 'di:注入' : process.env.ZHIHU_ACCESS_SECRET ? 'env:ZHIHU_ACCESS_SECRET' : accessSecret ? 'macOS Keychain' : 'missing',
          configured: Boolean(accessSecret),
          length: accessSecret.length,
          sha256Prefix: fingerprint(accessSecret),
        },
      },
    };
  }

  async function credentials() {
    const { appKey, accessSecret } = await credentialDetails();
    return { appKey, accessSecret };
  }

  function credentialWarnings(diagnostics) {
    const warnings = [];
    if (diagnostics.appKey.configured && diagnostics.appKey.length <= 8) {
      warnings.push({
        code: 'APP_KEY_TOO_SHORT',
        message: 'ZHIHU_OAUTH_APP_KEY 看起来过短，请确认没有填成 App ID。',
      });
    }
    if (
      diagnostics.appKey.configured &&
      oauthConfig.appId &&
      diagnostics.appKey.sha256Prefix === fingerprint(String(oauthConfig.appId))
    ) {
      warnings.push({
        code: 'APP_ID_USED_AS_APP_KEY',
        message: 'OAuth app_key 看起来等于 App ID。',
      });
    }
    if (
      diagnostics.appKey.configured &&
      diagnostics.accessSecret.configured &&
      diagnostics.appKey.sha256Prefix === diagnostics.accessSecret.sha256Prefix
    ) {
      warnings.push({
        code: 'APP_KEY_USED_AS_ACCESS_SECRET',
        message: 'ZHIHU_ACCESS_SECRET 看起来等于 OAuth App Key。',
      });
    }
    return warnings;
  }

  function exchangeDebug(code, diagnostics) {
    return {
      stage: 'callback_received',
      codeReceived: Boolean(code),
      codeLength: String(code || '').length,
      tokenExchange: {
        url: 'https://openapi.zhihu.com/access_token',
        method: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        appId: oauthConfig.appId,
        appKeySource: diagnostics.appKey.source,
        appKeyLength: diagnostics.appKey.length,
        appKeySha256Prefix: diagnostics.appKey.sha256Prefix,
        grantType: 'authorization_code',
        redirectUri: oauthConfig.redirectUri,
        codeField: 'code',
        codeLength: String(code || '').length,
      },
      accessSecret: diagnostics.accessSecret,
      credentialWarnings: credentialWarnings(diagnostics),
    };
  }

  async function status(request, response) {
    const current = session(request, response);
    const { appKey, accessSecret, diagnostics } = await credentialDetails();
    if (current.expiresAt && current.expiresAt <= Date.now()) {
      current.token = null;
      current.profile = null;
      current.error = { code: 'TOKEN_EXPIRED', message: '授权已过期，请重新连接。' };
    }
    return {
      configured: Boolean(appKey && accessSecret && oauthConfig.redirectUri),
      callbackConfigured: Boolean(oauthConfig.redirectUri),
      authorized: Boolean(current.token),
      appId: oauthConfig.appId,
      redirectUri: oauthConfig.redirectUri,
      profile: current.profile,
      stateVerified: current.stateVerified,
      expiresAt: current.expiresAt ? new Date(current.expiresAt).toISOString() : null,
      error: current.error,
      debug: current.debug,
      credentialDiagnostics: diagnostics,
      credentialWarnings: credentialWarnings(diagnostics),
      interfaces: userInterfaces,
    };
  }

  async function start(request, response, from = null) {
    const current = session(request, response);
    if (!oauthConfig.redirectUri) {
      throw Object.assign(new Error('本地地址无法完成知乎登录。请先部署应用并配置公网回调地址。'), { code: 'DEPLOYMENT_REQUIRED' });
    }
    const { appKey } = await credentials();
    if (!appKey) throw Object.assign(new Error('OAuth app_key 尚未配置'), { code: 'APP_KEY_REQUIRED' });
    current.state = randomBytes(24).toString('base64url');
    current.error = null;
    current.returnTo = isSafeReturnTo(from) ? from.slice(0, 500) : null;
    const url = new URL('https://openapi.zhihu.com/authorize');
    url.searchParams.set('redirect_uri', oauthConfig.redirectUri);
    url.searchParams.set('app_id', oauthConfig.appId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', current.state);
    return url.toString();
  }

  async function callback(request, response, url) {
    const current = session(request, response);
    const code = url.searchParams.get('authorization_code') || url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    const details = await credentialDetails();
    current.debug = exchangeDebug(code, details.diagnostics);
    if (!code) throw Object.assign(new Error('回调缺少 authorization_code'), { code: 'CODE_MISSING' });
    if (returnedState && !equal(returnedState, current.state)) {
      throw Object.assign(new Error('state 校验失败'), { code: 'STATE_MISMATCH' });
    }
    const { appKey, accessSecret } = details;
    if (!appKey || !accessSecret) throw new Error('后端凭证配置不完整');
    current.debug.stage = 'token_exchange_started';
    const form = new URLSearchParams({
      app_id: oauthConfig.appId,
      app_key: safe(appKey),
      grant_type: 'authorization_code',
      redirect_uri: oauthConfig.redirectUri,
      code: safe(code),
    }).toString();
    const payload = await httpJson('https://openapi.zhihu.com/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const token = payload?.access_token || payload?.data?.access_token || payload?.Data?.access_token;
    if (!token) throw payloadError(payload, '未获得 OAuth access token');
    const expiresIn = Number(payload?.expires_in ?? payload?.data?.expires_in ?? payload?.Data?.expires_in);
    current.debug.stage = 'token_exchange_succeeded';
    current.debug.tokenReceived = Boolean(token);
    current.debug.expiresIn = Number.isFinite(expiresIn) ? expiresIn : null;
    current.token = token;
    current.expiresAt = Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : null;
    current.stateVerified = Boolean(returnedState);
    current.state = null;
    current.error = null;

    try {
      current.debug.stage = 'profile_fetch_started';
      // 黑客松基础信息接口：仅 OAuth token 鉴权（不带 Access Secret/X-OAuth-Token——原脚手架此处鉴权头用错，按官方 0.7.2 文档修正）
      const profilePayload = await httpJson('https://openapi.zhihu.com/user', {
        headers: { Authorization: `Bearer ${safe(token)}` },
      });
      // 字段按官方文档：fullname / avatar_path（兼容包装形态 data/Data/user 与首字母大写变体）
      const source = [profilePayload?.data, profilePayload?.Data, profilePayload?.user, profilePayload]
        .find((candidate) => candidate && typeof candidate === 'object' && (candidate.fullname || candidate.Fullname || candidate.name || candidate.uid != null)) || null;
      if (source) {
        current.profile = {
          name: source.fullname || source.Fullname || source.name || null,
          avatarUrl: source.avatar_path || source.avatar_url || source.AvatarUrl || null,
          headline: source.headline || source.Headline || null,
          url: source.url || source.Url || null,
        };
      }
      current.debug.profileFetched = Boolean(current.profile);
    } catch { current.profile = null; current.debug.profileFetched = false; }
    current.debug.stage = 'authorized';
    // 登录回访：授权往返后回到来源视图（?run=/?report= 不丢）；校验失败回首页
    const back = isSafeReturnTo(current.returnTo) ? current.returnTo : null;
    current.returnTo = null;
    return back;
  }

  async function runAll(request, response) {
    const current = session(request, response);
    if (!current.token) throw Object.assign(new Error('请先完成知乎账号授权'), { code: 'LOGIN_REQUIRED' });
    const { accessSecret } = await credentials();
    if (!accessSecret) throw new Error('开放平台 Access Secret 未配置');
    const context = {};
    const results = [];
    for (const definition of userInterfaces) {
      let query = { Limit: '1' };
      if (definition.id === 'contents') query = { ...query, ContentType: 'all', Offset: '0', SortField: 'ts', SortOrder: 'desc' };
      if (definition.id === 'followees') query.Offset = '0';
      if (definition.id === 'favlist_contents') {
        if (!context.favlistToken) {
          results.push({ ...definition, status: 'empty', item: null, message: '账号没有可用于测试的收藏夹。' });
          continue;
        }
        query = { ...query, FavlistUrlToken: String(context.favlistToken), Offset: '0' };
      }
      try {
        const payload = await httpJson(`https://developer.zhihu.com${definition.endpoint}?${new URLSearchParams(query)}`, {
          headers: userRequestConfig(accessSecret, current.token),
          timeoutMs: 30_000,
        });
        if (payload?.Code !== 0) throw payloadError(payload, '用户数据接口失败');
        const item = firstItem(payload);
        if (definition.id === 'favlists' && item?.UrlToken) context.favlistToken = item.UrlToken;
        results.push({ ...definition, status: item ? 'success' : 'empty', item, message: item ? null : '接口成功但没有数据。' });
      } catch (error) {
        results.push({ ...definition, status: 'error', item: null, message: error.message });
      }
    }
    return results;
  }

  /** 个人历史（P0-B：登录解锁——计登录数不拦人的落点）：授权用户创作列表（标题+摘要，官方 0.7.2 文档口径）。
   *  按需拉取、会话内存持有、不落库；未登录/过期 → LOGIN_REQUIRED（前端 401 静默，不影响任何主功能） */
  async function contents(request, response, { limit = 10 } = {}) {
    const current = session(request, response);
    const expired = Boolean(current.token && current.expiresAt && current.expiresAt <= Date.now());
    if (expired) {
      current.token = null;
      current.profile = null;
      current.error = { code: 'TOKEN_EXPIRED', message: '授权已过期，请重新连接。' };
    }
    if (!current.token) {
      throw Object.assign(new Error(expired ? '授权已过期，请重新登录' : '请先完成知乎账号登录'), { code: expired ? 'TOKEN_EXPIRED' : 'LOGIN_REQUIRED' });
    }
    const { accessSecret } = await credentials();
    if (!accessSecret) throw Object.assign(new Error('开放平台 Access Secret 未配置（用户数据接口前置）'), { code: 'SECRET_MISSING' });
    const query = new URLSearchParams({
      ContentType: 'all',
      Offset: '0',
      Limit: String(Math.min(Math.max(Number(limit) || 10, 1), 50)),
      SortField: 'ts',
      SortOrder: 'desc',
    });
    const payload = await httpJson(`https://developer.zhihu.com/api/v1/user/contents?${query}`, {
      headers: userRequestConfig(accessSecret, current.token),
      timeoutMs: 30_000,
    });
    const code = payload?.Code ?? payload?.code;
    if (code !== 0) throw payloadError(payload, '创作列表获取失败');
    const items = (Array.isArray(payload?.Data?.Items) ? payload.Data.Items : []).map((item) => ({
      type: String(item?.ContentType || '').toLowerCase(),
      title: String(item?.Title || '').slice(0, 120),
      url: String(item?.Url || ''),
      summary: String(item?.Summary || '').slice(0, 200),
      created_at: Number(item?.CreatedAt) || null,
      like_count: Number(item?.LikeCount) || 0,
      comment_count: Number(item?.CommentCount) || 0,
      favorite_count: Number(item?.FavoriteCount) || 0,
    }));
    return { items, isEnd: payload?.Data?.Paging?.IsEnd !== false };
  }

  function logout(request, response) {
    const current = session(request, response);
    current.token = null; current.expiresAt = null; current.profile = null; current.state = null; current.stateVerified = null; current.error = null;
    current.debug = null; current.returnTo = null;
  }

  function record(request, response, error) {
    const current = session(request, response);
    if (current.debug) current.debug.failedStage = current.debug.stage;
    current.error = { code: String(error.code || 'OAUTH_FAILED'), message: String(error.message).slice(0, 200) };
  }

  return { status, start, callback, runAll, contents, logout, record };
}
