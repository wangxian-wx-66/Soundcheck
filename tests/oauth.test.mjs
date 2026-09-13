// P0-B OAuth 单测：登录回访 / profile 字段解析（本次修复回归）/ 个人历史 contents（全局 fetch 打桩，零外部依赖）
// 凭证经 createOAuth DI 注入（短 stub 值，非真实凭证、不触碰真实环境变量——pre-commit 密钥扫描友好）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOAuth } from '../lib/oauth.mjs';

const config = {
  oauth: { appId: '399', redirectUri: 'https://demo.example.com/auth/callback', credentialService: 'svc', credentialAccount: 'acc' },
};

const CREDENTIALS = { appKey: 'stub-app-key', accessSecret: 'stub-secret' };

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

/** fetch 打桩：按 URL 路由，记录调用（含 headers——鉴权头回归断言用） */
function stubFetch(routes, log = []) {
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    log.push({ url: target, headers: options.headers || {}, method: options.method || 'GET', body: options.body });
    for (const [pattern, payload] of routes) {
      if (target.includes(pattern)) return jsonResponse(payload);
    }
    return jsonResponse({});
  };
}

function fakePair(cookie = '') {
  const setCookies = [];
  return [
    { headers: { cookie } },
    { setHeader: (name, value) => { if (name === 'Set-Cookie') setCookies.push(value); }, _cookies: setCookies },
  ];
}

function sessionIdFrom(response) {
  const match = String(response._cookies[0] || '').match(/zhihu_hackathon_session=([^;]+)/);
  return match ? match[1] : null;
}

const PROFILE = { uid: 969570047710216200, fullname: '测试答主', headline: '一句话介绍', avatar_path: 'https://picx.zhimg.com/a.jpg', url: 'https://www.zhihu.com/people/test' };
const CONTENTS = {
  Code: 0,
  Data: {
    Items: [
      { ContentType: 'answer', Url: 'https://www.zhihu.com/question/20691338/answer/53910077', CreatedAt: 1757700000, LikeCount: 42, CommentCount: 3, FavoriteCount: 5, Title: '机器学习入门路线', Summary: '先补数学基础……' },
      { ContentType: 'article', Url: 'https://zhuanlan.zhihu.com/p/123', CreatedAt: 1757600000, LikeCount: 7, CommentCount: 0, FavoriteCount: 1, Title: '转行随笔', Summary: '从文科到码农……' },
    ],
    Paging: { IsEnd: true },
  },
};

test('oauth: 登录全流程（token 交换 → profile → returnTo 回访地址）', async () => {
  const log = [];
  stubFetch([
    ['openapi.zhihu.com/access_token', { access_token: 'tok-123', expires_in: 3600 }],
    ['openapi.zhihu.com/user', PROFILE],
    ['api/v1/user/contents', CONTENTS],
  ], log);

  const oauth = createOAuth(config, CREDENTIALS);
  const [request1, response1] = fakePair();
  const authorizeUrl = await oauth.start(request1, response1, '/?report=abc#review');
  const sid = sessionIdFrom(response1);
  assert.ok(sid, '应下发会话 Cookie');
  assert.match(authorizeUrl, /^https:\/\/openapi\.zhihu\.com\/authorize\?/);
  assert.match(authorizeUrl, /app_id=399/);
  const state = new URL(authorizeUrl).searchParams.get('state');
  assert.ok(state, '授权 URL 应带 state');

  // 回调：state 原样透传校验
  const [request2, response2] = fakePair(`zhihu_hackathon_session=${sid}`);
  const callbackUrl = new URL('https://demo.example.com/auth/callback?authorization_code=code-xyz&state=' + encodeURIComponent(state));
  const back = await oauth.callback(request2, response2, callbackUrl);
  assert.equal(back, '/?report=abc#review', '登录后应返回来源视图（returnTo）');

  // profile 字段解析回归：官方文档口径 fullname / avatar_path（原脚手架两处解析 miss）
  const status = await oauth.status(...fakePair(`zhihu_hackathon_session=${sid}`));
  assert.equal(status.authorized, true);
  assert.equal(status.profile.name, '测试答主');
  assert.equal(status.profile.avatarUrl, 'https://picx.zhimg.com/a.jpg');
  assert.equal(status.credentialDiagnostics.appKey.source, 'di:注入');

  // 鉴权头回归：/user 只带 OAuth token（不带 Access Secret / X-OAuth-Token）
  const userCall = log.find((entry) => entry.url.includes('openapi.zhihu.com/user'));
  assert.equal(userCall.headers.Authorization, 'Bearer tok-123');
  assert.equal(userCall.headers['X-OAuth-Token'], undefined);
});

test('oauth: 个人历史 contents——授权用户创作列表（标准化字段 + 雷达入口数据）', async () => {
  const log = [];
  stubFetch([
    ['openapi.zhihu.com/access_token', { access_token: 'tok-456', expires_in: 3600 }],
    ['openapi.zhihu.com/user', PROFILE],
    ['api/v1/user/contents', CONTENTS],
  ], log);

  const oauth = createOAuth(config, CREDENTIALS);
  const [, response1] = fakePair();
  await oauth.start({ headers: { cookie: '' } }, response1, '/');
  const sid = sessionIdFrom(response1);
  await oauth.callback(...fakePair(`zhihu_hackathon_session=${sid}`), new URL('https://demo.example.com/auth/callback?code=c&state='));

  const { items, isEnd } = await oauth.contents(...fakePair(`zhihu_hackathon_session=${sid}`), { limit: 10 });
  assert.equal(items.length, 2);
  assert.equal(items[0].type, 'answer');
  assert.equal(items[0].title, '机器学习入门路线');
  assert.equal(items[0].url, 'https://www.zhihu.com/question/20691338/answer/53910077');
  assert.equal(items[0].like_count, 42);
  assert.equal(items[0].created_at, 1757700000);
  assert.equal(isEnd, true);

  // 用户数据接口鉴权头：Access Secret（调用方）+ X-OAuth-Token（被代表用户）+ 时间戳
  const contentsCall = log.find((entry) => entry.url.includes('api/v1/user/contents'));
  assert.equal(contentsCall.headers.Authorization, 'Bearer stub-secret');
  assert.equal(contentsCall.headers['X-OAuth-Token'], 'tok-456');
  assert.ok(Number(contentsCall.headers['X-Request-Timestamp']) > 0);

  // limit 上限收敛（接口上限 50）
  assert.match(contentsCall.url, /Limit=10/);
});

test('oauth: 未登录/过期 → 401 错误码（不拦人：前端静默降级）', async () => {
  stubFetch([]);
  const oauth = createOAuth(config, CREDENTIALS);

  // 未登录
  await assert.rejects(() => oauth.contents(...fakePair(), {}), { code: 'LOGIN_REQUIRED' });

  // 过期（token 交换返回负 expires_in → 会话立即过期）
  stubFetch([
    ['openapi.zhihu.com/access_token', { access_token: 'tok-exp', expires_in: -10 }],
    ['openapi.zhihu.com/user', PROFILE],
  ]);
  const [, response1] = fakePair();
  await oauth.start({ headers: { cookie: '' } }, response1, '/');
  const sid = sessionIdFrom(response1);
  await oauth.callback(...fakePair(`zhihu_hackathon_session=${sid}`), new URL('https://demo.example.com/auth/callback?code=c&state='));
  await assert.rejects(() => oauth.contents(...fakePair(`zhihu_hackathon_session=${sid}`), {}), { code: 'TOKEN_EXPIRED' });
});

test('oauth: returnTo 开放重定向防护（外站地址一律拒绝回首页）', async () => {
  stubFetch([
    ['openapi.zhihu.com/access_token', { access_token: 'tok-789', expires_in: 3600 }],
    ['openapi.zhihu.com/user', PROFILE],
  ]);
  const oauth = createOAuth(config, CREDENTIALS);
  for (const evil of ['https://evil.example.com/phish', '//evil.example.com', '/\\evil.example.com', 'javascript:alert(1)']) {
    const [, response1] = fakePair();
    await oauth.start({ headers: { cookie: '' } }, response1, evil);
    const sid = sessionIdFrom(response1);
    const back = await oauth.callback(...fakePair(`zhihu_hackathon_session=${sid}`), new URL('https://demo.example.com/auth/callback?code=c&state='));
    assert.equal(back, null, `危险地址应被拒绝：${evil}`);
  }
});

test('oauth: 退出登录清空会话（contents 随即 401）', async () => {
  stubFetch([
    ['openapi.zhihu.com/access_token', { access_token: 'tok-x', expires_in: 3600 }],
    ['openapi.zhihu.com/user', PROFILE],
    ['api/v1/user/contents', CONTENTS],
  ]);
  const oauth = createOAuth(config, CREDENTIALS);
  const [, response1] = fakePair();
  await oauth.start({ headers: { cookie: '' } }, response1, '/');
  const sid = sessionIdFrom(response1);
  await oauth.callback(...fakePair(`zhihu_hackathon_session=${sid}`), new URL('https://demo.example.com/auth/callback?code=c&state='));

  const [logoutReq, logoutRes] = fakePair(`zhihu_hackathon_session=${sid}`);
  oauth.logout(logoutReq, logoutRes);
  await assert.rejects(() => oauth.contents(...fakePair(`zhihu_hackathon_session=${sid}`), {}), { code: 'LOGIN_REQUIRED' });
});
