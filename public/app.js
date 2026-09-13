// 试麦员 Soundcheck · 前端逻辑
// 契约：docs/UI设计规范_v1.md §六交互约定 + devlog/2026-09-13_P0-A主线开发.md §三 API 契约
import { renderPoster, downloadPoster } from './poster.js';

const $ = (selector) => document.querySelector(selector);

const els = {
  notice: $('#notice'), noticeText: $('#notice-text'),
  accountHint: $('#account-hint'), loginBtn: $('#login-btn'), accountUser: $('#account-user'),
  mine: $('#mine'), mineList: $('#mine-list'),
  cardRadar: $('#card-radar'), cardReview: $('#card-review'),
  radarQuestion: $('#radar-question'), radarStart: $('#radar-start'),
  reviewQuestion: $('#review-question'), reviewDraft: $('#review-draft'), reviewStart: $('#review-start'),
  hot: $('#hot'), hotList: $('#hot-list'), hotRefresh: $('#hot-refresh'),
  desk: $('#desk'), deskQ: $('#desk-q'), deskState: $('#desk-state'), deskStateText: $('#desk-state-text'),
  budgetUsed: $('#budget-used'), budgetSeg: $('#budget-seg'),
  gaugeLabel: $('#gauge-label'), gaugePct: $('#gauge-pct'), gaugeBar: $('#gauge-bar'),
  feed: $('#feed'), evidenceStream: $('#evidence-stream'),
  deskTrace: $('#desk-trace'), queueNote: $('#queue-note'), resumeNote: $('#resume-note'),
  deskBack: $('#desk-back'), reportBack: $('#report-back'),
  retryBtn: $('#retry-btn'),
  cynicPanel: $('#cynic-panel'), cynicFeed: $('#cynic-feed'), cynicState: $('#cynic-state'), cynicStateText: $('#cynic-state-text'),
  entry: $('#view-entry'),
  report: $('#report'), rGrade: $('#r-grade'), rTitle: $('#r-title'), rScale: $('#r-scale'),
  rVerdict: $('#r-verdict'), rBars: $('#r-bars'), rArgmap: $('#r-argmap'),
  rBmCount: $('#r-bm-count'), rBenchmarks: $('#r-benchmarks'),
  rRecentCount: $('#r-recent-count'), rRecent: $('#r-recent'),
  rIncrement: $('#r-increment'), rControversy: $('#r-controversy'), rTrace: $('#r-trace'),
  rBoundary: $('#r-boundary'), rBoundaryToggle: $('#r-boundary-toggle'), rBoundaryBody: $('#r-boundary-body'),
  rJurySec: $('#r-jury-sec'), rJuryVerdict: $('#r-jury-verdict'), rJuryDisagreements: $('#r-jury-disagreements'),
  rNitCount: $('#r-nit-count'), rNitpicks: $('#r-nitpicks'),
  copyLink: $('#copy-link'), restart: $('#restart'),
  makePoster: $('#make-poster'), posterOverlay: $('#poster-overlay'), posterClose: $('#poster-close'),
  posterCanvasWrap: $('#poster-canvas-wrap'), posterDownload: $('#poster-download'),
  opp: $('#opp'), oppNote: $('#opp-note'), oppList: $('#opp-list'), oppBoundary: $('#opp-boundary'),
  history: $('#history'), historyList: $('#history-list'), historyClear: $('#history-clear'),
  bgRun: $('#bg-run'), bgRunText: $('#bg-run-text'), bgRunView: $('#bg-run-view'),
  rGradeCap: $('#r-grade-cap'), rGradeLegend: $('#r-grade-legend'), rBarsCap: $('#r-bars-cap'),
  rIncSub: $('#r-inc-sub'), rCtrSub: $('#r-ctr-sub'),
};

// 证据等级 → 通俗表达（大众可读；L 编号仅留此处总图例做工程对照）
const EVIDENCE_LABEL = {
  L1: '社区排序', L2: '站内检索', L3: '真实评论', L4: 'AI 转述', 推导: '推导',
};

const RADAR_DIMS = [
  ['novelty', '新颖度', false], ['rigor', '严谨度', false],
  ['experience', '经验密度', true], ['resonance', '共鸣度', true],
];
const PLOT_LABEL = { covered: 'cov', unique: 'uniq', blank: 'blank' };
// 模式相关文案：radar（只输问题，无草稿）下 unique 语义是「该问题还缺的好回答方向」，不是「你的草稿独有」
let reportIsRadar = false;
const UNIQUE_TERM = () => (reportIsRadar ? '缺好回答' : '你的独有');

let currentRunId = null;
let eventSource = null;
let lastSeq = 0;
let lastMode = 'review'; // 失败重试用：记录最近一次发起的模式（?run= 回放时经 status 接口纠正）
let isReplayView = false; // ?run= 回访（刷新/返回恢复）时：done 后停留在研究台，不自动跳报告
let deskDone = false; // 研究台当前 run 是否已结束（done/failed）——B1：运行中点返回不报「报告不存在」
let deskFromReport = false; // 研究台是否从战报卡「← 返回」退回（回放态）——此态再点返回应回首页，避免战报⇄研究台死循环
let loggedIn = false; // 知乎登录态（历史区块标识：本机保存 vs 已云同步）

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
// 雷达输入框支持「标题可见 + URL 隐藏」：热榜/机会榜/我的创作点击后填标题（用户可读），
// 问题 URL 存 dataset.qurl（供后端精确定位标杆序）；用户手动输入即失效
const DRAFT_KEYS = { question: 'sc.radar.question', rq: 'sc.review.question', draft: 'sc.review.draft', qurl: 'sc.radar.qurl' };
let saveTimer = null;
function persistDrafts() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      sessionStorage.setItem(DRAFT_KEYS.question, els.radarQuestion.value);
      sessionStorage.setItem(DRAFT_KEYS.qurl, els.radarQuestion.dataset.qurl || '');
      sessionStorage.setItem(DRAFT_KEYS.rq, els.reviewQuestion.value);
      sessionStorage.setItem(DRAFT_KEYS.draft, els.reviewDraft.value);
    } catch { /* 存储不可用时静默 */ }
  }, 500);
}
for (const input of [els.radarQuestion, els.reviewQuestion, els.reviewDraft]) {
  input.addEventListener('input', () => {
    if (input === els.radarQuestion) delete els.radarQuestion.dataset.qurl; // 手动输入：URL 记录失效
    persistDrafts();
  });
}
function restoreDrafts() {
  try {
    els.radarQuestion.value = sessionStorage.getItem(DRAFT_KEYS.question) || '';
    const savedUrl = sessionStorage.getItem(DRAFT_KEYS.qurl);
    if (savedUrl) els.radarQuestion.dataset.qurl = savedUrl;
    els.reviewQuestion.value = sessionStorage.getItem(DRAFT_KEYS.rq) || '';
    els.reviewDraft.value = sessionStorage.getItem(DRAFT_KEYS.draft) || '';
  } catch { /* 忽略 */ }
}

/** 填入雷达输入框：显示标题，URL 进 dataset（B3：点击热榜/机会榜/我的创作不再裸露链接） */
function setRadarInput({ title, url }) {
  els.radarQuestion.value = title;
  if (url) els.radarQuestion.dataset.qurl = url; else delete els.radarQuestion.dataset.qurl;
  persistDrafts();
  location.hash = '#radar';
  applyRoute();
  els.radarQuestion.focus();
}

// ---------- 视图切换（URL 同步：刷新后保持当前视图，不回首页） ----------
function currentView() {
  if (!els.entry.hidden) return 'entry';
  if (!els.desk.hidden) return 'desk';
  return 'report';
}
function showView(name) {
  const from = currentView();
  els.entry.hidden = name !== 'entry';
  els.desk.hidden = name !== 'desk';
  els.report.hidden = name !== 'report';
  if (name !== 'entry' && from !== name) window.scrollTo({ top: 0 });
  // URL 与视图同步：回首页清掉 run/report 参数；进 desk/report 保持参数可刷新恢复
  if (name === 'entry') {
    if (location.search) history.replaceState(null, '', location.pathname + (location.hash || ''));
  }
}

// 返回按钮：上一视图是报告则回报告（再试一次），否则回首页
function goBack() {
  const params = new URLSearchParams(location.search);
  const runId = params.get('run');
  const reportId = params.get('report');
  if (reportId || currentRunId) {
    const target = reportId || currentRunId;
    loadReport(target);
  } else if (runId) {
    currentRunId = runId;
    isReplayView = true; // 返回恢复：同刷新回访，完成停在研究台
    eventSource?.close();
    resetDesk('');
    showView('desk');
    connectEvents(runId);
  } else {
    showView('entry');
    applyRoute();
  }
}
els.deskBack.addEventListener('click', () => {
  // B1 修复：分析进行中点返回 → 不再加载未生成的报告（404「报告不存在」吓人），
  // 而是回首页并留下后台任务入口——任务在服务端跑完落库（设计原则：额度已烧，结果必留）
  if (currentRunId && !deskDone) {
    leaveRunInBackground();
    return;
  }
  // 死循环修复：研究台若是「从战报卡退回来的回放态」，再点返回直接回首页
  // （原逻辑 goBack 会因 currentRunId 存在又拉回战报 → 战报⇄研究台永远出不去）
  if (deskFromReport) {
    deskFromReport = false;
    showView('entry');
    applyRoute();
    return;
  }
  goBack();
});
// 报告页返回（修复：原逻辑会 loadReport 当前报告 → 原地无响应）：
// 本会话发起的分析 → 回研究台回放过程；分享链接 ?report= 进入（无会话 run）→ 回首页
els.reportBack.addEventListener('click', () => {
  if (currentRunId) {
    deskFromReport = true; // 标记回放态：研究台再点返回时回首页
    isReplayView = true;
    eventSource?.close();
    resetDesk('');
    showView('desk');
    connectEvents(currentRunId);
  } else {
    showView('entry');
    applyRoute();
  }
});

// ---------- 后台任务胶囊（B1）：离开运行中的研究台后，首页给出回到入口 + 完成提醒 ----------
let bgRunId = null;
let bgRunState = 'running'; // running | done
let bgPollTimer = null;
function leaveRunInBackground() {
  bgRunId = currentRunId;
  bgRunState = 'running';
  eventSource?.close();
  showBgPill('分析仍在后台进行，完成后这里可以查看', '回到研究台');
  showView('entry');
  applyRoute();
  startBgPoll();
}
function showBgPill(text, action) {
  els.bgRunText.textContent = text;
  els.bgRunView.textContent = action;
  els.bgRun.hidden = false;
}
function hideBgPill() {
  bgRunId = null;
  if (bgPollTimer) { clearInterval(bgPollTimer); bgPollTimer = null; }
  els.bgRun.hidden = true;
}
function startBgPoll() {
  if (bgPollTimer) clearInterval(bgPollTimer);
  bgPollTimer = setInterval(async () => {
    if (!bgRunId) return hideBgPill();
    try {
      const response = await fetch(`/api/run/${bgRunId}/status`);
      const payload = await response.json();
      if (!payload.ok) return;
      if (payload.status === 'done') {
        bgRunState = 'done';
        showBgPill('分析完成', '查看战报 →');
        clearInterval(bgPollTimer); bgPollTimer = null;
      } else if (payload.status === 'failed') {
        hideBgPill();
        notify('后台分析未能完成，可回首页重新发起', 'error');
      }
    } catch { /* 网络抖动：继续轮询 */ }
  }, 4000);
}
els.bgRunView.addEventListener('click', () => {
  if (!bgRunId) return;
  const runId = bgRunId;
  const state = bgRunState;
  hideBgPill();
  if (state === 'done') {
    currentRunId = runId;
    loadReport(runId);
  } else {
    currentRunId = runId;
    isReplayView = true; // 回放模式：完成停在研究台
    deskFromReport = false; // 主流程回到研究台（非战报退回态）
    resetDesk('');
    showView('desk');
    connectEvents(runId);
  }
});

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
  deskDone = false;
  els.feed.replaceChildren();
  els.evidenceStream.replaceChildren();
  els.deskQ.textContent = question || '';
  els.budgetUsed.textContent = '0';
  for (const cell of els.budgetSeg.children) cell.className = '';
  setGauge(0, '准备中');
  els.resumeNote.classList.remove('show');
  els.queueNote.hidden = true;
  els.retryBtn.hidden = true;
  setDeskState('running', '分析中');
  els.deskTrace.textContent = '';
  els.cynicPanel.hidden = true;
  els.cynicFeed.replaceChildren();
  setCynicState('running', '找茬中');
  // 骨架步骤：后续事件推进状态
  stepNode({ key: 'parse', title: '解析输入', state: 'idle' });
  stepNode({ key: 'report', title: '生成报告', state: 'idle' });
  setStep('parse', { state: 'run' });
}

// ---------- 杠精 Agent 发言流（P1 双角色） ----------
function cynicStep(patch) {
  let node = els.cynicFeed.querySelector(`[data-key="${patch.key}"]`);
  if (!node) {
    node = document.createElement('div');
    node.className = `cynic-line ${patch.state || 'idle'}`;
    node.dataset.key = patch.key;
    const ico = document.createElement('span');
    ico.className = 'cynic-ico';
    const main = document.createElement('div');
    main.className = 'cynic-main';
    node.append(ico, main);
    node._main = main;
    els.cynicFeed.append(node);
  }
  if (patch.state) node.className = `cynic-line ${patch.state}`;
  if (patch.title || patch.detail) {
    const line = document.createElement('div');
    line.className = 'cynic-text';
    if (patch.title) {
      const b = document.createElement('b');
      b.textContent = patch.title;
      line.append(b);
    }
    if (patch.detail) line.append(document.createTextNode(patch.detail));
    node._main.append(line);
    node._main.scrollIntoView?.({ block: 'nearest' });
  }
  if (patch.chips?.length) {
    const row = document.createElement('div');
    row.className = 'cynic-chips';
    for (const chip of patch.chips) {
      const c = document.createElement('span');
      c.className = `chip-mini${chip.kind ? ' ' + chip.kind : ''}`;
      c.textContent = chip.text;
      row.append(c);
    }
    node._main.append(row);
  }
  return node;
}

function setCynicState(state, text) {
  if (els.cynicPanel.hidden) return;
  els.cynicState.className = `state-pill ${state}`;
  els.cynicStateText.textContent = text;
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
  // C4 修复（诚实口径）：进度 = 检索预算用量本身，不再伪装成「证据充分度」
  setGauge(Math.min(100, Math.round((used / total) * 100)), used >= total ? '收尾中' : used >= 3 ? '检索过半' : '检索中');
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
      deskDone = true;
      setStep('report', { state: 'done' });
      for (const step of els.feed.querySelectorAll('.step.run')) step.className = 'step done';
      setGauge(100, '完成');
      setDeskState('done', '已完成');
      // 主动发起：自动进报告；回访（刷新/返回恢复）：停在研究台，出「查看战报」入口
      if (isReplayView) {
        const viewBtn = document.createElement('button');
        viewBtn.className = 'btn primary small';
        viewBtn.textContent = '查看战报 →';
        viewBtn.onclick = () => { if (currentRunId) loadReport(currentRunId); };
        els.deskTrace.textContent = '';
        els.deskTrace.append(viewBtn);
      } else if (currentRunId) {
        loadReport(currentRunId);
      }
      break;
    case 'cynic_start':
      els.cynicPanel.hidden = false;
      setCynicState('running', '找茬中');
      cynicStep({ key: 'cynic-boot', state: 'run', title: '接手草稿', detail: '—— 主审在检索，我独立读稿找茬' });
      break;
    case 'cynic_done': {
      setCynicState('done', '找茬完成');
      cynicStep({ key: 'cynic-boot', state: 'done' });
      for (let i = 1; i <= (data.nitpicks || 0); i++) {
        cynicStep({ key: `nit-${i}`, state: 'done', title: `找茬 ${'①②③④⑤'[i - 1] || i}`, detail: '—— 最狠的杠法已就位' });
      }
      const chips = [];
      if (data.own_rating) chips.push({ text: `杠精评级 ${data.own_rating}`, kind: 'warn' });
      if (data.disagreements) chips.push({ text: `与主审分歧 ${data.disagreements} 处` });
      if (chips.length) cynicStep({ key: 'cynic-sum', state: 'done', chips });
      break;
    }
    case 'cynic_failed':
      setCynicState('failed', '找茬失败');
      cynicStep({ key: 'cynic-boot', state: 'fail', title: '杠精缺席', detail: `—— ${data.message || '本次未能完成对抗审阅'}（主审报告不受影响）` });
      break;
    case 'failed':
      deskDone = true;
      for (const step of els.feed.querySelectorAll('.step.run')) step.className = 'step fail';
      setDeskState('failed', '失败');
      els.retryBtn.hidden = false;
      notify(data.message ? `分析失败：${data.message}` : '分析失败，请重试', 'error', true);
      break;
  }
}

function connectEvents(runId) {
  eventSource?.close();
  lastSeq = 0;
  // B2 修复：回放 ?run= 链接（分享出去的失败任务）时，从 status 接口纠正重试模式，
  // 避免「radar 失败 → 重试却按 review 发起 → 提示先粘贴草稿」的错位
  fetch(`/api/run/${runId}/status`).then((r) => r.json()).then((p) => {
    if (p.ok && p.mode) lastMode = p.mode;
  }).catch(() => { /* 状态查询失败不阻断回放 */ });
  const source = new EventSource(`/api/run/${runId}/events`);
  eventSource = source;
  let reconnects = 0;
  const types = ['queued', 'start', 'parse', 'search_start', 'search_done', 'benchmark_start', 'benchmark_done', 'evidence', 'budget', 'final_start', 'cynic_start', 'cynic_done', 'cynic_failed', 'done', 'failed'];
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
  if (mode === 'radar' && !question) return notify('先输入一个问题，或从热榜 / 机会榜选一个');
  if (mode === 'review' && !draft) return notify('先粘贴草稿，再开始试麦');
  lastMode = mode;
  isReplayView = false; // 主动发起：完成后自动进报告
  hideBgPill(); // 新分析开始：旧后台任务入口收起

  const button = mode === 'radar' ? els.radarStart : els.reviewStart;
  button.disabled = true;
  try {
    // B3：点击热榜/机会榜/我的创作时输入框显示标题，问题 URL 走 question_url 精确定位标杆序
    const questionUrl = mode === 'radar' ? (els.radarQuestion.dataset.qurl || '') : '';
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, question, draft, question_url: questionUrl }),
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
// 失败态重试：用表单里现有的输入重新发起（草稿仍在输入框/sessionStorage 中）
els.retryBtn.addEventListener('click', () => startAnalysis(lastMode));

// ---------- 战报卡渲染 ----------
/** 四维条 + 增量地图（含地块点击详情）——由 renderReport 调用 */
function renderReportCharts(r, argMap) {
  // 防御性清理：避免 renderReport 多次调用累积多个 arg-detail 节点
  const staleDetail = document.getElementById('arg-detail');
  if (staleDetail) staleDetail.remove();
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
      est.textContent = ' 估算';
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
    plot.tabIndex = 0; // 可聚焦：键盘也能看详情
    const evLabel = EVIDENCE_LABEL[slot.evidence_level] || slot.evidence_level || '推导';
    const ev = document.createElement('span');
    ev.className = 'p-e';
    ev.textContent = evLabel;
    const text = document.createElement('span');
    text.className = 'p-t';
    text.textContent = slot.argument;
    plot.append(ev, text);
    // 悬停完整论点（原生 title 兜底）；点击在下方详情区展开
    plot.title = `${slot.argument}\n依据：${evLabel}${slot.source_urls?.length ? `\n原文：${slot.source_urls[0]}` : ''}`;
    plot.addEventListener('click', () => {
      for (const p of els.rArgmap.querySelectorAll('.arg-plot')) p.classList.remove('active');
      plot.classList.add('active');
      renderArgDetail(slot, evLabel);
    });
    els.rArgmap.append(plot);
  }
  // 地块详情区（默认显示第一块，避免空区）
  const detailBox = document.createElement('div');
  detailBox.className = 'arg-detail';
  detailBox.id = 'arg-detail';
  els.rArgmap.after(detailBox);
  if (argMap[0]) {
    els.rArgmap.querySelector('.arg-plot')?.classList.add('active');
    renderArgDetail(argMap[0], EVIDENCE_LABEL[argMap[0].evidence_level] || argMap[0].evidence_level || '推导');
  }
}

/** 地块点击后的详情：完整论点 + 状态 + 判断依据 + 原文链接 */
function renderArgDetail(slot, evLabel) {
  const box = document.getElementById('arg-detail');
  if (!box) return;
  box.replaceChildren();
  const head = document.createElement('div');
  head.className = 'arg-detail-head';
  const statusName = { covered: '已被覆盖', unique: UNIQUE_TERM(), blank: '相邻空白' }[slot.status] || slot.status;
  const tag = document.createElement('span');
  tag.className = `tag ${PLOT_LABEL[slot.status] || 'cov'}`;
  tag.textContent = statusName;
  const ev = document.createElement('span');
  ev.className = 'badge-evi';
  ev.textContent = `依据：${evLabel}`;
  head.append(tag, ev);
  const body = document.createElement('p');
  body.className = 'arg-detail-text';
  body.textContent = slot.argument;
  box.append(head, body);
  for (const url of slot.source_urls || []) {
    const link = document.createElement('a');
    link.className = 'arg-detail-link';
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '查看原文 ↗';
    box.append(link);
    break; // 主依据一条即够，避免堆链接
  }
}

function renderReport(runId, report) {
  const r = report;
  reportIsRadar = (r.trace?.mode || '') === 'radar';
  els.rGrade.textContent = r.rating || '–';
  // A2/D6：评级语义随模式切换 + 四档含义一行小字（原先全站无解释）
  els.rGradeCap.textContent = reportIsRadar ? '机会评级' : '增量评级';
  els.rGradeLegend.textContent = reportIsRadar
    ? 'S 很缺好回答 · A 值得写 · B 竞争偏多 · C 已被写透'
    : 'S 显著独有增量 · A 有明确增量 · B 少量增量 · C 基本被覆盖';
  els.rBarsCap.textContent = reportIsRadar ? '问题四维体检（基于社区讨论估算）' : '草稿四维体检';
  els.rIncSub.textContent = reportIsRadar ? '这个问题还缺什么，机会在哪' : '你的增量在哪，怎么放大';
  els.rCtrSub.textContent = reportIsRadar ? '未来答主最可能被杠的点' : '评论区最可能的杠法，与应对';
  els.rTitle.textContent = r.question_title || '（未命名）';

  const benchmarks = r.coverage?.benchmarks || [];
  const recent = r.coverage?.recent || [];
  const argMap = r.coverage?.argument_map || [];
  renderReportCharts(r, argMap);
  // 地图图例随模式切换（radar 下蓝色地块是「缺好回答的方向」，不是草稿独有）
  const legendL2 = document.querySelector('.map-legend .l2');
  if (legendL2?.lastChild) legendL2.lastChild.textContent = UNIQUE_TERM();
  const evidenceCount = {};
  for (const item of [...benchmarks, ...recent, ...argMap]) {
    const label = EVIDENCE_LABEL[item.evidence_level] || item.evidence_level || '推导';
    evidenceCount[label] = (evidenceCount[label] || 0) + 1;
  }
  const evidenceText = Object.entries(evidenceCount).map(([k, v]) => `${k}×${v}`).join(' ');
  els.rScale.innerHTML = '';
  els.rScale.append(reportIsRadar ? '已梳理 ' : '对比 ');
  const b1 = document.createElement('b'); b1.textContent = `${benchmarks.length} 条标杆回答`;
  els.rScale.append(b1, '（社区序）+ ');
  const b2 = document.createElement('b'); b2.textContent = `${recent.length} 条近期讨论`;
  els.rScale.append(b2, evidenceText ? ` · 依据 ${evidenceText}` : '');

  const inc = r.increment || {};
  const uniqN = (inc.unique || []).length;
  const covN = (inc.covered || []).length;
  const blankN = (inc.blanks || []).length;
  els.rVerdict.hidden = false;
  els.rVerdict.innerHTML = '';
  els.rVerdict.append('结论：');
  const strong = document.createElement('b');
  if (reportIsRadar) {
    strong.textContent = `还缺 ${uniqN} 个好回答方向`;
    els.rVerdict.append(strong, ` · ${covN} 个已被充分覆盖 · ${blankN} 个相邻空白`);
  } else {
    strong.textContent = `${uniqN} 个独有增量`;
    els.rVerdict.append(strong, ` · ${covN} 个已被覆盖 · ${blankN} 个相邻空白`);
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
  renderLinkList(els.rBenchmarks, benchmarks, (item) => ({ text: EVIDENCE_LABEL[item.evidence_level] || item.evidence_level || '社区排序' }));
  renderLinkList(els.rRecent, recent, (item) => ({ text: `${item.votes ?? 0}赞 ${item.authority || ''}`.trim(), l2: true }));
  els.rBmCount.textContent = String(benchmarks.length);
  els.rRecentCount.textContent = String(recent.length);

  els.rIncrement.replaceChildren();
  const incRows = [
    ...(inc.covered || []).map((t) => ['cov', '已覆盖', t]),
    ...(inc.unique || []).map((t) => ['uniq', reportIsRadar ? '缺好回答' : '独有', t]),
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
      badge.textContent = real ? '真实评论佐证' : '推导';
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

  // ---------- 评审团分歧（P1 双角色） ----------
  const cynic = r.cynic;
  els.rJurySec.hidden = !cynic;
  if (cynic) {
    els.rJuryVerdict.replaceChildren();
    const chiefSide = document.createElement('div');
    chiefSide.className = 'jury-side chief';
    chiefSide.append(Object.assign(document.createElement('span'), { className: 'jury-name', textContent: '主审 Agent' }));
    const chiefGrade = document.createElement('b');
    chiefGrade.textContent = r.rating || '–';
    chiefSide.append(chiefGrade);
    chiefSide.append(Object.assign(document.createElement('span'), { className: 'jury-cap', textContent: '研究型 · 检索对比' }));
    const vs = document.createElement('span');
    vs.className = 'jury-vs';
    vs.textContent = 'VS';
    const cynicSide = document.createElement('div');
    cynicSide.className = 'jury-side cynic';
    cynicSide.append(Object.assign(document.createElement('span'), { className: 'jury-name', textContent: '杠精 Agent' }));
    const cynicGrade = document.createElement('b');
    cynicGrade.textContent = cynic.own_rating || '–';
    if (cynic.own_rating && cynic.own_rating !== r.rating) cynicGrade.className = 'diff';
    cynicSide.append(cynicGrade);
    cynicSide.append(Object.assign(document.createElement('span'), { className: 'jury-cap', textContent: '对抗型 · 专门找茬' }));
    els.rJuryVerdict.append(chiefSide, vs, cynicSide);

    els.rJuryDisagreements.replaceChildren();
    for (const d of cynic.disagreements || []) {
      const row = document.createElement('div');
      row.className = 'jury-row';
      const point = document.createElement('div');
      point.className = 'jury-point';
      point.textContent = d.point || '分歧';
      const body = document.createElement('div');
      body.className = 'jury-body';
      const chief = document.createElement('div');
      chief.className = 'jury-chief';
      chief.append(Object.assign(document.createElement('i'), { textContent: '主审' }), document.createTextNode(d.chief || ''));
      const bar = document.createElement('div');
      bar.className = 'jury-bar';
      const cynicView = document.createElement('div');
      cynicView.className = 'jury-cynic';
      cynicView.append(Object.assign(document.createElement('i'), { textContent: '杠精' }), document.createTextNode(d.cynic || ''));
      body.append(chief, bar, cynicView);
      row.append(point, body);
      els.rJuryDisagreements.append(row);
    }
    if (!cynic.disagreements?.length) {
      const note = document.createElement('p');
      note.className = 'sub';
      note.style.marginLeft = '26px';
      note.textContent = '两位评审这次意见一致。';
      els.rJuryDisagreements.append(note);
    }

    els.rNitpicks.replaceChildren();
    for (const n of cynic.nitpicks || []) {
      const row = document.createElement('div');
      row.className = 'nit-row';
      const head = document.createElement('div');
      head.className = 'nit-head';
      const obj = document.createElement('b');
      obj.textContent = n.objection || '';
      const badge = document.createElement('span');
      const real = n.evidence === 'real';
      badge.className = `badge-evi ${real ? 'real' : 'infer'}`;
      badge.textContent = real ? '真实评论佐证' : '推导';
      head.append(obj, badge);
      const why = document.createElement('div');
      why.className = 'nit-why';
      why.textContent = n.why ? `为什么社区会这么杠：${n.why}` : '';
      const src = document.createElement('div');
      src.className = 'nit-src';
      src.textContent = real ? `评论原文：「${n.source || ''}」` : (n.source || '');
      row.append(head, why);
      if (src.textContent) row.append(src);
      els.rNitpicks.append(row);
    }
    els.rNitCount.textContent = String((cynic.nitpicks || []).length);
  }

  const trace = r.trace || {};
  const time = trace.generated_at ? new Date(trace.generated_at).toLocaleString('zh-CN', { hour12: false }) : '';
  // D2：trace 行只留用户可理解的信息（run id 属开发者语言，URL 里已有）
  els.rTrace.textContent = `${trace.tool_calls ?? '–'}/6 次检索 · ${time}`;
  const note = String(r.meta?.note || '').trim();
  if (note) {
    els.rBoundary.hidden = false;
    els.rBoundaryBody.textContent = note;
    els.rBoundaryBody.classList.remove('expanded');
    els.rBoundaryToggle.textContent = '展开全部 ▾';
    els.rBoundaryToggle.setAttribute('aria-expanded', 'false');
  } else {
    els.rBoundary.hidden = true;
  }

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
  // 分享海报（P2）：canvas 手绘 3:4 PNG，纯前端生成
  els.makePoster.onclick = () => {
    try {
      els.posterCanvasWrap.replaceChildren();
      const canvas = renderPoster(r, { runId, reportUrl: `${location.host}/?report=${runId}` });
      canvas.className = 'poster-canvas';
      els.posterCanvasWrap.append(canvas);
      els.posterDownload.onclick = () => downloadPoster(canvas, `soundcheck-${String(runId).slice(0, 8)}.png`);
      els.posterOverlay.hidden = false;
    } catch (error) {
      notify(`海报生成失败：${error.message || error}`);
    }
  };
  els.restart.onclick = () => {
    showView('entry');
    applyRoute();
  };

  showView('report');
}

// 证据边界说明：展开 / 收起（长文完整可读）
els.rBoundaryToggle?.addEventListener('click', () => {
  const expanded = els.rBoundaryBody.classList.toggle('expanded');
  els.rBoundaryToggle.textContent = expanded ? '收起 ▴' : '展开全部 ▾';
  els.rBoundaryToggle.setAttribute('aria-expanded', String(expanded));
});

async function loadReport(runId) {
  try {
    const response = await fetch(`/api/report/${runId}`);
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error?.message || '报告加载失败');
    renderReport(runId, payload.result);
    // 分析历史：报告渲染即入索引（本地发起、回访、分享链接进入都会记录）
    saveHistoryEntry({
      runId,
      title: payload.result?.question_title || payload.question || '',
      rating: payload.result?.rating || '',
      mode: payload.result?.trace?.mode || payload.mode || '',
      ts: Date.now(),
    });
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
    row.addEventListener('click', () => setRadarInput({ title: item.title, url: item.url }));
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

// ---------- 海报弹窗（P2） ----------
function closePoster() { els.posterOverlay.hidden = true; }
els.posterClose.addEventListener('click', closePoster);
els.posterOverlay.addEventListener('click', (event) => {
  if (event.target === els.posterOverlay) closePoster(); // 点遮罩关闭
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !els.posterOverlay.hidden) closePoster();
});

// ---------- 机会榜（P2：热榜上还缺好回答的问题，每日预计算） ----------
async function loadOpportunities() {
  try {
    const response = await fetch('/api/opportunities');
    const payload = await response.json();
    if (!response.ok || !payload.ok || !payload.items?.length) return;
    renderOpportunities(payload);
  } catch { /* 机会榜不可用不阻塞主流程 */ }
}

function renderOpportunities(payload) {
  els.oppList.replaceChildren();
  for (const item of payload.items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'opp-item';
    const rank = document.createElement('span');
    rank.className = 'opp-rank';
    rank.textContent = `#${item.rank}`;
    const main = document.createElement('div');
    main.className = 'opp-main';
    const titleLine = document.createElement('div');
    titleLine.className = 'opp-title';
    titleLine.textContent = item.title;
    const gapRow = document.createElement('div');
    gapRow.className = 'opp-gap-row';
    const gapBar = document.createElement('div');
    gapBar.className = 'opp-gap-bar';
    const fill = document.createElement('i');
    fill.style.width = `${Math.max(4, Math.min(100, item.gap))}%`;
    gapBar.append(fill);
    const gapLabel = document.createElement('span');
    gapLabel.className = 'opp-gap-label';
    gapLabel.textContent = `空缺度 ${item.gap}`;
    gapRow.append(gapBar, gapLabel);
    const reason = document.createElement('div');
    reason.className = 'opp-reason';
    reason.textContent = item.reason;
    main.append(titleLine, gapRow, reason);
    const go = document.createElement('span');
    go.className = 'go';
    go.textContent = '去试麦 →';
    row.append(rank, main, go);
    row.addEventListener('click', () => setRadarInput({ title: item.title, url: item.url }));
    els.oppList.append(row);
  }
  els.oppNote.textContent = payload.cached ? '每日预计算' : '刚出炉';
  // C2：评分边界诚实声明（搜索偏近期，早年高赞标杆可能未被收录）
  els.oppBoundary.textContent = payload.note || '';
  els.opp.hidden = false;
}

// ---------- OAuth 登录态（P0-B：登录解锁个人历史——计登录数，不拦任何主功能） ----------
// 创作类型 → 中文标签（知乎用户数据接口 ContentType 口径）
const CONTENT_TYPE_LABEL = { answer: '回答', article: '文章', zvideo: '视频', pin: '想法', question: '问题' };

function showLoginEntry() {
  els.accountHint.hidden = false;
  els.loginBtn.hidden = false;
  els.accountUser.hidden = true;
  els.mine.hidden = true;
  // 登录回访：记住当前视图（?run=/?report=/hash），授权往返后原界面不丢
  els.loginBtn.href = `/api/oauth/start?from=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
}

function renderAccountUser(profile) {
  els.accountHint.hidden = true;
  els.loginBtn.hidden = true;
  els.accountUser.replaceChildren();
  if (profile?.avatarUrl) {
    const img = document.createElement('img');
    img.src = profile.avatarUrl;
    img.alt = '知乎头像';
    els.accountUser.append(img);
  }
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = profile?.name || '已连接知乎账号';
  if (profile?.headline) who.title = profile.headline;
  const logout = document.createElement('button');
  logout.type = 'button';
  logout.className = 'btn-zhihu logout-btn';
  logout.textContent = '退出';
  logout.addEventListener('click', async () => {
    try { await fetch('/api/oauth/logout', { method: 'POST' }); } catch { /* 忽略 */ }
    showLoginEntry();
    loggedIn = false;
    renderHistory(); // 历史区块标识同步退出态
    notify('已退出知乎登录', 'info');
  });
  els.accountUser.append(who, logout);
  els.accountUser.hidden = false;
}

async function loadAccount() {
  let connected = false;
  let oauthError = null;
  try {
    const response = await fetch('/api/oauth/status');
    const payload = await response.json();
    if (payload.ok && (payload.authorized === true || payload.profile)) {
      connected = true;
      renderAccountUser(payload.profile);
      loadMine();
    }
    if (payload?.error?.message) oauthError = payload.error.message;
  } catch { /* 未登录保持默认 */ }
  if (!connected) showLoginEntry();
  loggedIn = connected; // 历史区块登录态标识（未登录「本机保存」，已登录「已云同步」）
  renderHistory();
  const params = new URLSearchParams(location.search);
  if (params.get('oauth') === 'success') {
    notify(connected ? '知乎账号已连接，「我的创作」已解锁' : '知乎登录会话未建立，可直接使用分析功能', 'info');
  }
  if (params.get('oauth') === 'error') {
    notify(oauthError ? `知乎登录未完成：${oauthError}` : '知乎登录未完成，可直接使用分析功能', 'info');
  }
}

// ---------- 我的创作（个人历史：OAuth 创作列表，登录后解锁） ----------
async function loadMine() {
  try {
    const response = await fetch('/api/user/contents?limit=10');
    const payload = await response.json();
    if (!response.ok || !payload.ok) return; // 401（未登录/过期）等静默降级，不影响主功能
    renderMine(payload.items || []);
  } catch { /* 静默：个人历史加载失败不阻塞 */ }
}

function formatMineStats(item) {
  const parts = [`赞 ${item.like_count ?? 0}`, `评 ${item.comment_count ?? 0}`, `藏 ${item.favorite_count ?? 0}`];
  if (item.created_at) {
    const date = new Date(item.created_at * 1000);
    parts.push(`${date.getMonth() + 1}/${date.getDate()}`);
  }
  return parts.join(' · ');
}

function renderMine(items) {
  els.mineList.replaceChildren();
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'mine-item';
    const line = document.createElement('div');
    line.className = 'mine-line';
    const type = document.createElement('span');
    type.className = `mine-type ${item.type || 'answer'}`;
    type.textContent = CONTENT_TYPE_LABEL[item.type] || '内容';
    const title = document.createElement('a');
    title.className = 'mine-title';
    title.href = item.url || '#';
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    title.textContent = item.title || '（无标题）';
    const stats = document.createElement('span');
    stats.className = 'mine-stats';
    stats.textContent = formatMineStats(item);
    line.append(type, title, stats);
    // 快捷入口：回答/问题 → 一键选题雷达（看该问题现在的论点版图，P3 复盘的前置钩子）
    const questionUrl = String(item.url || '').match(/zhihu\.com\/question\/\d+/)?.[0];
    if (questionUrl) {
      const radar = document.createElement('button');
      radar.type = 'button';
      radar.className = 'mine-radar';
      radar.textContent = '选题雷达 →';
      radar.addEventListener('click', () => setRadarInput({ title: item.title || questionUrl, url: `https://www.${questionUrl}` }));
      line.append(radar);
    }
    row.append(line);
    if (item.summary) {
      const summary = document.createElement('p');
      summary.className = 'mine-summary';
      summary.textContent = item.summary;
      row.append(summary);
    }
    els.mineList.append(row);
  }
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'mine-empty';
    empty.textContent = '授权账号暂无公开创作。';
    els.mineList.append(empty);
  }
  els.mine.hidden = false;
}

// ---------- 本站分析历史（localStorage 索引 + 服务端 reports 表本体；无需登录） ----------
// 设计：本地只存 {runId, 标题, 评级, 模式, 时间} 索引（≤8 条），报告完整数据在服务端
// （LRU 1000 覆盖全评审期）——?report= 链接刷新/换 tab 都能复原战报卡
const HISTORY_KEY = 'sc.history';
const HISTORY_MAX = 8;

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}
function saveHistoryEntry(entry) {
  try {
    const list = loadHistory().filter((item) => item.runId !== entry.runId);
    list.unshift(entry);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
  } catch { /* 存储不可用时静默 */ }
  renderHistory();
}
function renderHistory() {
  const list = loadHistory();
  // 登录态引导（用户定位：历史是登录价值之一）：未登录提示云同步价值，已登录显示已云同步
  const headSpan = els.history.querySelector('.history-head > span');
  if (headSpan) {
    const count = list.length ? ` <em>最近 ${Math.min(list.length, HISTORY_MAX)} 次</em>` : '';
    headSpan.innerHTML = '';
    headSpan.append(loggedIn ? '我的分析历史 ' : '分析历史 ');
    if (loggedIn) {
      const em = document.createElement('em');
      em.textContent = '已云同步';
      em.style.color = 'var(--brand)';
      headSpan.append(em);
    } else if (list.length) {
      const em = document.createElement('em');
      em.textContent = '本机保存 · 登录后跨设备恢复';
      headSpan.append(em);
    } else {
      headSpan.append(count.trimStart());
    }
  }
  els.historyList.replaceChildren();
  for (const item of list) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'history-item';
    const grade = document.createElement('span');
    grade.className = `history-grade ${item.rating || ''}`;
    grade.textContent = item.rating || '–';
    const main = document.createElement('div');
    main.className = 'history-main';
    const title = document.createElement('span');
    title.className = 'history-title';
    title.textContent = item.title || '（未命名）';
    const meta = document.createElement('span');
    meta.className = 'history-meta';
    const time = item.ts ? new Date(item.ts).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    meta.textContent = `${item.mode === 'radar' ? '选题雷达' : '开麦评审'} · ${time}`;
    main.append(title, meta);
    const go = document.createElement('span');
    go.className = 'go';
    go.textContent = '战报 →';
    row.append(grade, main, go);
    row.addEventListener('click', () => {
      currentRunId = item.runId;
      loadReport(item.runId);
    });
    els.historyList.append(row);
  }
  els.history.hidden = list.length === 0;
}
els.historyClear.addEventListener('click', () => {
  try { localStorage.removeItem(HISTORY_KEY); } catch { /* 忽略 */ }
  renderHistory();
});

// ---------- 入口：?report= 回访 / ?run= 续看 ----------
function boot() {
  applyRoute();
  restoreDrafts();
  renderHistory();
  loadAccount();
  loadHot();
  loadOpportunities();
  const params = new URLSearchParams(location.search);
  const reportId = params.get('report');
  const runId = params.get('run');
  if (reportId) {
    showView('report');
    loadReport(reportId);
  } else if (runId) {
    currentRunId = runId;
    isReplayView = true; // 回访：回放过程，完成后停在研究台（「查看战报」入口），不强制跳报告
    resetDesk('');
    showView('desk');
    connectEvents(runId);
  }
}
boot();
