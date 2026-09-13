// 试麦员 Soundcheck · 前端逻辑
// 契约：docs/UI设计规范_v1.md §六交互约定 + devlog/2026-09-13_P0-A主线开发.md §三 API 契约
const $ = (selector) => document.querySelector(selector);

const els = {
  notice: $('#notice'), noticeText: $('#notice-text'),
  accountHint: $('#account-hint'), loginBtn: $('#login-btn'),
  cardRadar: $('#card-radar'), cardReview: $('#card-review'),
  radarQuestion: $('#radar-question'), radarStart: $('#radar-start'),
  reviewQuestion: $('#review-question'), reviewDraft: $('#review-draft'), reviewStart: $('#review-start'),
  hot: $('#hot'), hotList: $('#hot-list'), hotRefresh: $('#hot-refresh'),
  desk: $('#desk'), deskQ: $('#desk-q'), deskState: $('#desk-state'), deskStateText: $('#desk-state-text'),
  budgetUsed: $('#budget-used'), budgetSeg: $('#budget-seg'),
  gaugeLabel: $('#gauge-label'), gaugePct: $('#gauge-pct'), gaugeBar: $('#gauge-bar'),
  feed: $('#feed'), evidenceStream: $('#evidence-stream'),
  deskTrace: $('#desk-trace'), queueNote: $('#queue-note'), resumeNote: $('#resume-note'),
  entry: $('#view-entry'),
  report: $('#report'), rGrade: $('#r-grade'), rTitle: $('#r-title'), rScale: $('#r-scale'),
  rVerdict: $('#r-verdict'), rBars: $('#r-bars'), rArgmap: $('#r-argmap'),
  rBmCount: $('#r-bm-count'), rBenchmarks: $('#r-benchmarks'),
  rRecentCount: $('#r-recent-count'), rRecent: $('#r-recent'),
  rIncrement: $('#r-increment'), rControversy: $('#r-controversy'), rTrace: $('#r-trace'),
  copyLink: $('#copy-link'), restart: $('#restart'),
};

const RADAR_DIMS = [
  ['novelty', '新颖度', false], ['rigor', '严谨度', false],
  ['experience', '经验密度', true], ['resonance', '共鸣度', true],
];
const PLOT_LABEL = { covered: 'cov', unique: 'uniq', blank: 'blank' };

let currentRunId = null;
let eventSource = null;
let lastSeq = 0;

// ---------- 通知（一行红/灰字，不弹窗） ----------
let noticeTimer = null;
function notify(message, kind = 'error', sticky = false) {
  els.notice.hidden = false;
  els.noticeText.textContent = message;
  els.noticeText.className = kind;
  clearTimeout(noticeTimer);
  if (!sticky) noticeTimer = setTimeout(() => { els.notice.hidden = true; }, 6000);
}

// ---------- hash 路由：#radar / #review（切换不卸载组件） ----------
function applyRoute() {
  const hash = location.hash.replace('#', '');
  const mode = hash === 'review' ? 'review' : 'radar';
  els.cardRadar.classList.toggle('active', mode === 'radar');
  els.cardReview.classList.toggle('active', mode === 'review');
  return mode;
}
window.addEventListener('hashchange', applyRoute);
for (const card of [els.cardRadar, els.cardReview]) {
  card.addEventListener('click', (event) => {
    if (event.target.closest('input,textarea,button,a,label')) return;
    location.hash = card.dataset.mode === 'review' ? '#review' : '#radar';
  });
}

// ---------- 草稿暂存：sessionStorage 防抖 500ms（关标签即清，隐私承诺） ----------
const DRAFT_KEYS = { question: 'sc.radar.question', rq: 'sc.review.question', draft: 'sc.review.draft' };
let saveTimer = null;
function persistDrafts() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      sessionStorage.setItem(DRAFT_KEYS.question, els.radarQuestion.value);
      sessionStorage.setItem(DRAFT_KEYS.rq, els.reviewQuestion.value);
      sessionStorage.setItem(DRAFT_KEYS.draft, els.reviewDraft.value);
    } catch { /* 存储不可用时静默 */ }
  }, 500);
}
for (const input of [els.radarQuestion, els.reviewQuestion, els.reviewDraft]) input.addEventListener('input', persistDrafts);
function restoreDrafts() {
  try {
    els.radarQuestion.value = sessionStorage.getItem(DRAFT_KEYS.question) || '';
    els.reviewQuestion.value = sessionStorage.getItem(DRAFT_KEYS.rq) || '';
    els.reviewDraft.value = sessionStorage.getItem(DRAFT_KEYS.draft) || '';
  } catch { /* 忽略 */ }
}

// ---------- 视图切换 ----------
function showView(name) {
  els.entry.hidden = name !== 'entry';
  els.desk.hidden = name !== 'desk';
  els.report.hidden = name !== 'report';
  if (name !== 'entry') window.scrollTo({ top: 0 });
}

// ---------- 研究台 ----------
function stepNode(step) {
  const node = document.createElement('div');
  node.className = `step ${step.state || 'idle'}`;
  node.dataset.key = step.key;
  const title = document.createElement('div');
  title.className = 'step-title';
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = step.title;
  title.append(t);
  if (step.kw) {
    const kw = document.createElement('span');
    kw.className = 'kw';
    kw.textContent = step.kw;
    title.append(kw);
  }
  const detail = document.createElement('div');
  detail.className = 'step-detail';
  node.append(Object.assign(document.createElement('span'), { className: 'step-ico' }));
  const main = document.createElement('div');
  main.append(title, detail);
  node.append(main);
  node._detail = detail;
  node._title = title;
  els.feed.append(node);
  return node;
}

function setStep(key, patch) {
  let node = els.feed.querySelector(`[data-key="${key}"]`);
  if (!node) node = stepNode({ key, title: patch.title || key, kw: patch.kw });
  if (patch.state) node.className = `step ${patch.state}`;
  if (patch.title) node._title.querySelector('.t').textContent = patch.title;
  if (patch.kw && !node._title.querySelector('.kw')) {
    const kw = document.createElement('span');
    kw.className = 'kw';
    kw.textContent = patch.kw;
    node._title.append(kw);
  }
  if (patch.sub) {
    let sub = node._title.querySelector('.sub');
    if (!sub) { sub = document.createElement('span'); sub.className = 'sub'; node._title.append(sub); }
    sub.textContent = patch.sub;
  }
  if (patch.detail !== undefined) node._detail.textContent = patch.detail;
  if (patch.chips?.length) {
    node._detail.textContent = patch.detail || '';
    for (const chip of patch.chips) {
      const c = document.createElement('span');
      c.className = `chip-mini${chip.kind ? ' ' + chip.kind : ''}`;
      c.textContent = chip.text;
      node._detail.append(c);
    }
  }
  return node;
}

function resetDesk(question) {
  els.feed.replaceChildren();
  els.evidenceStream.replaceChildren();
  els.deskQ.textContent = question || '';
  els.budgetUsed.textContent = '0';
  for (const cell of els.budgetSeg.children) cell.className = '';
  setGauge(0, '准备中');
  els.resumeNote.classList.remove('show');
  els.queueNote.hidden = true;
  setDeskState('running', '分析中');
  els.deskTrace.textContent = '';
  // 骨架步骤：后续事件推进状态
  stepNode({ key: 'parse', title: '解析输入', state: 'idle' });
  stepNode({ key: 'report', title: '生成报告', state: 'idle' });
  setStep('parse', { state: 'run' });
}

function setDeskState(state, text) {
  els.deskState.className = `state-pill ${state}`;
  els.deskStateText.textContent = text;
}

function setGauge(pct, label) {
  els.gaugeBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  els.gaugePct.textContent = `${Math.round(pct)}%`;
  if (label) els.gaugeLabel.textContent = label;
}

function updateBudget(used, total) {
  els.budgetUsed.textContent = String(used);
  const cells = els.budgetSeg.children;
  for (let i = 0; i < cells.length; i++) cells[i].className = i < used ? 'on' : '';
  // 证据充分度与预算推进弱相关：检索推进 → 充分度爬升
  setGauge(Math.min(90, 15 + (used / total) * 75), used >= total ? '即将收尾' : used >= 3 ? '接近充分' : '采集中');
}

function addEvidenceChips(chips) {
  for (const chip of (chips || [])) {
    const node = document.createElement('div');
    node.className = `evi-chip${chip.type === 'benchmark' ? ' benchmark' : ''}`;
    const sep = chip.label.indexOf(' ');
    if (sep > 0) {
      const b = document.createElement('b');
      b.textContent = chip.label.slice(0, sep);
      node.append(b, document.createTextNode(chip.label.slice(sep + 1)));
    } else {
      node.textContent = chip.label;
    }
    els.evidenceStream.append(node);
  }
  // 边栏最多展示 8 条，超出滚动
  while (els.evidenceStream.children.length > 8) els.evidenceStream.firstChild.remove();
}

function handleEvent(event) {
  const { type, data = {}, seq } = event;
  lastSeq = Math.max(lastSeq, seq || 0);
  els.deskTrace.textContent = currentRunId ? `run ${currentRunId.slice(0, 8)}… · 事件 seq ${lastSeq}` : '';
  switch (type) {
    case 'queued':
      setDeskState('queued', '排队中');
      els.queueNote.hidden = false;
      els.queueNote.textContent = `前方 ${data.position} 人，请稍候`;
      break;
    case 'start':
      setDeskState('running', '分析中');
      els.queueNote.hidden = true;
      break;
    case 'parse':
      setStep('parse', { state: 'done', detail: `提炼 ${data.arguments?.length || 0} 个论点 · 检索词 ${data.search_queries?.length || 0} 组` });
      break;
    case 'search_start':
      setStep(`search-${data.round}`, { state: 'run', title: `检索 ${'①②③④⑤⑥'[(data.round || 1) - 1] || data.round}`, kw: data.query });
      setDeskState('running', '检索中');
      break;
    case 'search_done': {
      const chips = [];
      if (data.cached) chips.push({ text: '缓存命中', kind: 'bm' });
      setStep(`search-${data.round}`, { state: 'done', detail: `采纳 ${data.adopted} 条`, chips });
      setDeskState('running', '分析中');
      break;
    }
    case 'benchmark_start':
      setStep('benchmark', { state: 'run', title: '拉取标杆序', sub: data.injected ? '标准步骤' : '' });
      break;
    case 'benchmark_done':
      setStep('benchmark', { state: 'done', detail: `社区序前 ${data.count} 条到位`, chips: [{ text: '标杆 L1', kind: 'bm' }] });
      break;
    case 'evidence':
      addEvidenceChips(data.chips);
      break;
    case 'budget':
      updateBudget(data.used || 0, data.total || 6);
      break;
    case 'final_start':
      setStep('report', { state: 'run', title: '生成报告' });
      setGauge(95, '生成中');
      setDeskState('running', '生成报告');
      break;
    case 'done':
      setStep('report', { state: 'done' });
      for (const step of els.feed.querySelectorAll('.step.run')) step.className = 'step done';
      setGauge(100, '完成');
      setDeskState('done', '已完成');
      if (currentRunId) loadReport(currentRunId);
      break;
    case 'failed':
      for (const step of els.feed.querySelectorAll('.step.run')) step.className = 'step fail';
      setDeskState('failed', '失败');
      notify(data.message ? `分析失败：${data.message}` : '分析失败，请重试', 'error', true);
      break;
  }
}

function connectEvents(runId) {
  eventSource?.close();
  lastSeq = 0;
  const source = new EventSource(`/api/run/${runId}/events`);
  eventSource = source;
  let reconnects = 0;
  const types = ['queued', 'start', 'parse', 'search_start', 'search_done', 'benchmark_start', 'benchmark_done', 'evidence', 'budget', 'final_start', 'done', 'failed'];
  for (const type of types) {
    source.addEventListener(type, (message) => {
      try { handleEvent(JSON.parse(message.data)); } catch { /* 单条事件解析失败不致命 */ }
    });
  }
  source.onerror = () => {
    // EventSource 自动重连（带 Last-Event-ID）；服务端跑完落库，任务不重跑
    if (source.readyState === EventSource.CONNECTING && ++reconnects >= 1) els.resumeNote.classList.add('show');
  };
  source.addEventListener('done', () => source.close());
  source.addEventListener('failed', () => source.close());
}

// ---------- 发起分析 ----------
async function startAnalysis(mode) {
  const question = (mode === 'radar' ? els.radarQuestion : els.reviewQuestion).value.trim();
  const draft = els.reviewDraft.value.trim();
  if (mode === 'radar' && !question) return notify('先输入一个问题，或从热榜选一个');
  if (mode === 'review' && !draft) return notify('先粘贴草稿，再开始试麦');

  const button = mode === 'radar' ? els.radarStart : els.reviewStart;
  button.disabled = true;
  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, question, draft }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error?.message || '发起失败');
    currentRunId = payload.runId;
    try { sessionStorage.setItem('sc.lastRunId', currentRunId); } catch { /* 忽略 */ }
    resetDesk(question || '开麦评审');
    showView('desk');
    history.replaceState(null, '', `/?run=${currentRunId}${location.hash || '#review'}`);
    connectEvents(currentRunId);
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
}

els.radarStart.addEventListener('click', () => startAnalysis('radar'));
els.reviewStart.addEventListener('click', () => startAnalysis('review'));

// ---------- 战报卡渲染 ----------
function renderReport(runId, report) {
  const r = report;
  els.rGrade.textContent = r.rating || '–';
  els.rTitle.textContent = r.question_title || '（未命名）';

  const benchmarks = r.coverage?.benchmarks || [];
  const recent = r.coverage?.recent || [];
  const argMap = r.coverage?.argument_map || [];
  const evidenceCount = {};
  for (const item of [...benchmarks, ...recent, ...argMap]) {
    const level = String(item.evidence_level || '推导');
    evidenceCount[level] = (evidenceCount[level] || 0) + 1;
  }
  const evidenceText = Object.entries(evidenceCount).map(([k, v]) => `${k}×${v}`).join(' ');
  els.rScale.innerHTML = '';
  els.rScale.append('对比 ');
  const b1 = document.createElement('b'); b1.textContent = `${benchmarks.length} 条标杆回答`;
  els.rScale.append(b1, '（社区序）+ ');
  const b2 = document.createElement('b'); b2.textContent = `${recent.length} 条近期讨论`;
  els.rScale.append(b2, evidenceText ? ` · 证据 ${evidenceText}` : '');

  const inc = r.increment || {};
  const uniqN = (inc.unique || []).length;
  const covN = (inc.covered || []).length;
  const blankN = (inc.blanks || []).length;
  els.rVerdict.hidden = false;
  els.rVerdict.innerHTML = '';
  els.rVerdict.append('结论：');
  const strong = document.createElement('b');
  strong.textContent = `${uniqN} 个独有增量`;
  els.rVerdict.append(strong, ` · ${covN} 个已被覆盖 · ${blankN} 个相邻空白`);

  els.rBars.replaceChildren();
  for (const [key, label, isEst] of RADAR_DIMS) {
    const value = Math.max(0, Math.min(10, Number(r.radar?.[key] ?? 0)));
    const wrap = document.createElement('div');
    wrap.className = 'radar-bar';
    const lab = document.createElement('div');
    lab.className = 'lab';
    const name = document.createElement('span');
    name.textContent = label;
    if (isEst) {
      const est = document.createElement('i');
      est.className = 'est';
      est.textContent = ' 启发式';
      name.append(est);
    }
    const num = document.createElement('b');
    num.textContent = String(value);
    lab.append(name, num);
    const track = document.createElement('div');
    track.className = 'track';
    const fill = document.createElement('i');
    if (isEst) fill.className = 'est';
    fill.style.width = `${value * 10}%`;
    track.append(fill);
    wrap.append(lab, track);
    els.rBars.append(wrap);
  }

  els.rArgmap.replaceChildren();
  for (const slot of argMap) {
    const plot = document.createElement('div');
    plot.className = `arg-plot ${PLOT_LABEL[slot.status] || 'cov'}`;
    plot.title = slot.source_urls?.length ? `依据：${slot.source_urls.join('、')}` : '推导判断，无直接原文';
    const ev = document.createElement('span');
    ev.className = 'p-e';
    ev.textContent = slot.evidence_level || '推导';
    const text = document.createElement('span');
    text.className = 'p-t';
    text.textContent = slot.argument;
    plot.append(ev, text);
    els.rArgmap.append(plot);
  }

  const renderLinkList = (ul, items, renderMeta) => {
    ul.replaceChildren();
    for (const item of items) {
      const li = document.createElement('li');
      const rk = document.createElement('span');
      rk.className = 'rk';
      rk.textContent = item.rank ? `#${item.rank}` : '·';
      const link = document.createElement('a');
      link.className = 'lk';
      link.href = item.url || '#';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = item.title || item.url || '（无标题）';
      const meta = document.createElement('span');
      meta.className = 'ev';
      const metaText = renderMeta(item);
      meta.textContent = metaText.text;
      if (metaText.l2) meta.classList.add('l2');
      li.append(rk, link, meta);
      ul.append(li);
    }
    if (!items.length) {
      const li = document.createElement('li');
      li.textContent = '（本次未采集到该层证据）';
      li.style.color = 'var(--text-3)';
      ul.append(li);
    }
  };
  renderLinkList(els.rBenchmarks, benchmarks, (item) => ({ text: item.evidence_level || 'L1' }));
  renderLinkList(els.rRecent, recent, (item) => ({ text: `${item.votes ?? 0}赞 ${item.authority || ''}`.trim(), l2: true }));
  els.rBmCount.textContent = String(benchmarks.length);
  els.rRecentCount.textContent = String(recent.length);

  els.rIncrement.replaceChildren();
  const incRows = [
    ...(inc.covered || []).map((t) => ['cov', '已覆盖', t]),
    ...(inc.unique || []).map((t) => ['uniq', '独有', t]),
    ...(inc.blanks || []).map((t) => ['blank', '空白', t]),
    ...(inc.amplify ? [['act', '建议', inc.amplify]] : []),
  ];
  for (const [kind, tag, text] of incRows) {
    const row = document.createElement('div');
    row.className = 'inc-row';
    const tagEl = document.createElement('span');
    tagEl.className = `tag ${kind}`;
    tagEl.textContent = tag;
    const body = document.createElement('span');
    body.textContent = text;
    row.append(tagEl, body);
    els.rIncrement.append(row);
  }

  els.rControversy.replaceChildren();
  for (const item of r.controversy?.objections || []) {
    const row = document.createElement('div');
    row.className = 'cto-row';
    const left = document.createElement('div');
    left.className = 'side-l';
    left.textContent = item.objection;
    const arrow = document.createElement('div');
    arrow.className = 'arrow';
    arrow.textContent = '→';
    const right = document.createElement('div');
    right.className = 'side-r';
    right.textContent = item.response;
    const src = document.createElement('div');
    src.className = 'src';
    const badge = document.createElement('span');
    const real = item.evidence === 'real';
    badge.className = `badge-evi ${real ? 'real' : 'infer'}`;
    badge.textContent = real ? 'L3 真实评论' : '推导';
    src.append(badge, document.createTextNode(item.source || ''));
    row.append(left, arrow, right, src);
    els.rControversy.append(row);
  }
  if (!r.controversy?.objections?.length) {
    const empty = document.createElement('p');
    empty.className = 'sub';
    empty.style.marginLeft = '26px';
    empty.textContent = '本次未预测到高置信度反驳。';
    els.rControversy.append(empty);
  }

  const trace = r.trace || {};
  const time = trace.generated_at ? new Date(trace.generated_at).toLocaleString('zh-CN', { hour12: false }) : '';
  els.rTrace.textContent = `run ${String(runId).slice(0, 8)}… · ${trace.tool_calls ?? '–'}/6 次检索 · ${time}\n${r.meta?.note || '判断基于检索摘要（非全文），点击论点对照原文'}`;

  els.copyLink.onclick = async () => {
    const url = `${location.origin}/?report=${runId}`;
    try {
      await navigator.clipboard.writeText(url);
      els.copyLink.textContent = '已复制';
      setTimeout(() => { els.copyLink.textContent = '复制链接'; }, 1600);
    } catch {
      notify('复制失败，请手动复制地址栏链接');
    }
  };
  els.restart.onclick = () => {
    history.replaceState(null, '', '/#review');
    showView('entry');
    applyRoute();
  };

  showView('report');
}

async function loadReport(runId) {
  try {
    const response = await fetch(`/api/report/${runId}`);
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error?.message || '报告加载失败');
    renderReport(runId, payload.result);
    history.replaceState(null, '', `/?report=${runId}`);
  } catch (error) {
    notify(error.message);
  }
}

// ---------- 热榜 ----------
let hotItems = [];
let hotOffset = 0;
function renderHot() {
  const items = hotItems.slice(hotOffset, hotOffset + 4);
  els.hotList.replaceChildren();
  items.forEach((item, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'hot-item';
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = String(hotOffset + index + 1);
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = item.title;
    const go = document.createElement('span');
    go.className = 'go';
    go.textContent = '选题雷达 →';
    row.append(n, t, go);
    row.addEventListener('click', () => {
      els.radarQuestion.value = item.url || item.title;
      persistDrafts();
      location.hash = '#radar';
      applyRoute();
      els.radarQuestion.focus();
    });
    els.hotList.append(row);
  });
  els.hot.hidden = items.length === 0;
}
async function loadHot() {
  try {
    const response = await fetch('/api/hot');
    const payload = await response.json();
    if (!response.ok || !payload.ok || !payload.items?.length) return;
    hotItems = payload.items;
    renderHot();
  } catch { /* 热榜不可用时不阻塞主流程 */ }
}
els.hotRefresh.addEventListener('click', () => {
  hotOffset = (hotOffset + 4) % Math.max(hotItems.length, 1);
  renderHot();
});

// ---------- OAuth 状态（登录人数计人气奖） ----------
async function loadAccount() {
  try {
    const response = await fetch('/api/oauth/status');
    const payload = await response.json();
    const profile = payload?.profile || payload?.account;
    if (payload.ok && (profile?.name || payload.authorized === true)) {
      els.loginBtn.hidden = true;
      els.accountHint.textContent = profile?.name ? `已连接：${profile.name}` : '已连接知乎账号';
      if (profile?.avatar || profile?.avatarUrl) {
        const img = document.createElement('img');
        img.src = profile.avatar || profile.avatarUrl;
        img.alt = '知乎头像';
        els.accountHint.before(img);
      }
    }
  } catch { /* 未登录保持默认 */ }
  const params = new URLSearchParams(location.search);
  if (params.get('oauth') === 'success') notify('知乎账号已连接', 'info');
  if (params.get('oauth') === 'error') notify('知乎登录未完成，可直接使用分析功能', 'info');
}

// ---------- 入口：?report= 回访 / ?run= 续看 ----------
function boot() {
  applyRoute();
  restoreDrafts();
  loadAccount();
  loadHot();
  const params = new URLSearchParams(location.search);
  const reportId = params.get('report');
  const runId = params.get('run');
  if (reportId) {
    showView('report');
    loadReport(reportId);
  } else if (runId) {
    currentRunId = runId;
    resetDesk('');
    showView('desk');
    connectEvents(runId);
    // 若服务端已完成，SSE 回放里即有 done → 自动进报告
  }
}
boot();
