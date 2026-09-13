// 分享海报（P2）：3:4 竖版 PNG，原生 Canvas 2D 手绘——纯前端生成，不上传服务器
// 决策记录：原计划 html2canvas，因 CSP style-src 'self'（无 unsafe-inline）会阻断其内联样式克隆，
// 且引入 ~200KB vendor 依赖；改手绘与「手写 SVG」视觉纪律一致（决策见 devlog/2026-09-14_P2海报机会榜预热.md）
const W = 900;
const H = 1200;
const SCALE = 2; // 2x 出图（1800×2400），高分屏截图传播不糊

// design tokens（styles.css 同源，取值唯一来源 docs/UI设计规范_v1.md）
const C = {
  bg: '#FAFAFB', surface: '#FFFFFF', border: '#E4E6EB', divider: '#EEF0F3',
  text: '#18181B', text2: '#52525B', text3: '#8E8E96',
  brand: '#056DE8', brandSoft: '#EAF2FD', brandLine: '#BFD7F6',
  green: '#18794E', greenSoft: '#EAF6EF',
  amber: '#B45309', amberSoft: '#FEF4E2',
  red: '#C03744', redSoft: '#FCEEEE',
};
const FONT = '"PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif';
const FONT_GRADE = 'Georgia, "Times New Roman", serif';

const RATING_COLOR = { S: C.brand, A: C.green, B: C.amber, C: C.text3 };
const PLOT_COLOR = { covered: '#D4D6DB', unique: C.brand, blank: '#FFFFFF' };

/** CJK 逐字换行（中文无空格，按字符断行；英文单词尽量不拆） */
function wrapText(ctx, text, maxWidth, maxLines) {
  const lines = [];
  let line = '';
  for (const char of String(text)) {
    if (char === '\n') { lines.push(line); line = ''; continue; }
    if (ctx.measureText(line + char).width > maxWidth && line) {
      lines.push(line);
      line = char;
      if (lines.length >= maxLines) break;
    } else {
      line += char;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length >= maxLines) {
    let last = lines[maxLines - 1];
    while (last && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last}…`;
  }
  return lines.slice(0, maxLines);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 麦克风品牌图标（与顶栏 SVG 同款，Path2D 复用 SVG 路径数据） */
function drawMic(ctx, x, y, size, color) {
  const s = size / 14;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  roundRect(ctx, 4.5, 1, 5, 7, 2.5);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(7, 7, 4.5, Math.PI, 0); // 下半弧
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(7, 11.5);
  ctx.lineTo(7, 13.5);
  ctx.stroke();
  ctx.restore();
}

/**
 * 渲染分享海报
 * @param {object} report 战报卡 result（/api/report/:id 的 result）
 * @param {object} options { runId, reportUrl }
 * @returns {HTMLCanvasElement}
 */
export function renderPoster(report, { runId = '', reportUrl = '' } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);

  // 背景 + 主卡面
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = C.surface;
  roundRect(ctx, 24, 24, W - 48, H - 48, 16);
  ctx.fill();
  ctx.strokeStyle = C.border;
  ctx.lineWidth = 1;
  ctx.stroke();

  const pad = 64;
  const inner = W - pad * 2;
  let y = 96;

  // ---- 品牌行 ----
  drawMic(ctx, pad, 70, 30, C.text);
  ctx.fillStyle = C.text;
  ctx.font = `600 24px ${FONT}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('试麦员', pad + 44, 92);
  ctx.fillStyle = C.text3;
  ctx.font = `400 15px ${FONT}`;
  ctx.fillText('Soundcheck', pad + 126, 92);
  ctx.fillStyle = C.text3;
  ctx.font = `400 15px ${FONT}`;
  const slogan = '开麦前，先试麦';
  ctx.fillText(slogan, W - pad - ctx.measureText(slogan).width, 92);

  y = 150;
  ctx.strokeStyle = C.divider;
  ctx.beginPath();
  ctx.moveTo(pad, y);
  ctx.lineTo(W - pad, y);
  ctx.stroke();
  y += 56;

  // ---- 评级章 + 标题 ----
  const rating = ['S', 'A', 'B', 'C'].includes(report?.rating) ? report.rating : '–';
  const ratingColor = RATING_COLOR[rating] || C.text2;
  const stampSize = 128;
  ctx.fillStyle = C.bg;
  roundRect(ctx, pad, y, stampSize, stampSize, 14);
  ctx.fill();
  ctx.strokeStyle = ratingColor;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = ratingColor;
  ctx.font = `700 84px ${FONT_GRADE}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(rating, pad + stampSize / 2, y + stampSize / 2 + 6);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C.text3;
  ctx.font = `400 13px ${FONT}`;
  ctx.fillText('增量评级', pad, y + stampSize + 26);

  const titleX = pad + stampSize + 32;
  const titleW = W - pad - titleX;
  ctx.font = `600 26px ${FONT}`;
  ctx.fillStyle = C.text;
  const titleLines = wrapText(ctx, report?.question_title || '（未命名）', titleW, 3);
  let ty = y + 34;
  for (const line of titleLines) { ctx.fillText(line, titleX, ty); ty += 38; }

  const inc = report?.increment || {};
  const uniqN = (inc.unique || []).length;
  const covN = (inc.covered || []).length;
  const blankN = (inc.blanks || []).length;
  ctx.font = `400 15px ${FONT}`;
  ctx.fillStyle = C.text2;
  ctx.fillText(`${uniqN} 个独有增量 · ${covN} 个已被覆盖 · ${blankN} 个相邻空白`, titleX, y + 34 + 38 * 3 + 10);

  y += stampSize + 64;

  // ---- 四维条 ----
  ctx.fillStyle = C.text3;
  ctx.font = `400 13px ${FONT}`;
  ctx.fillText('四维体检', pad, y - 12);
  y += 14;
  const dims = [
    ['新颖度', report?.radar?.novelty], ['严谨度', report?.radar?.rigor],
    ['经验密度', report?.radar?.experience], ['共鸣度', report?.radar?.resonance],
  ];
  const barH = 12;
  const barGap = 34;
  for (const [label, raw] of dims) {
    const value = Math.max(0, Math.min(10, Math.round(Number(raw) || 0)));
    ctx.fillStyle = C.text2;
    ctx.font = `400 14px ${FONT}`;
    ctx.fillText(label, pad, y + barH + 1);
    const barX = pad + 90;
    const barW = inner - 90 - 44;
    ctx.fillStyle = C.divider;
    roundRect(ctx, barX, y, barW, barH, barH / 2);
    ctx.fill();
    ctx.fillStyle = value >= 7 ? C.brand : C.text2;
    if (value > 0) { roundRect(ctx, barX, y, Math.max(barH, (barW * value) / 10), barH, barH / 2); ctx.fill(); }
    ctx.fillStyle = C.text;
    ctx.font = `600 14px ${FONT}`;
    const numText = String(value);
    ctx.fillText(numText, W - pad - ctx.measureText(numText).width, y + barH + 1);
    y += barH + barGap - 12;
  }

  y += 30;

  // ---- 增量地图（12 地块条） ----
  ctx.fillStyle = C.text3;
  ctx.font = `400 13px ${FONT}`;
  ctx.fillText('论点版图（灰 已覆盖 · 蓝 你的独有 · 虚线 空白）', pad, y - 12);
  y += 14;
  const argMap = report?.coverage?.argument_map || [];
  const cols = 4;
  const rows = Math.max(3, Math.ceil(argMap.length / cols) || 3);
  const cellGap = 10;
  const cellW = (inner - cellGap * (cols - 1)) / cols;
  const cellH = 52;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const slot = argMap[row * cols + col];
      const x = pad + col * (cellW + cellGap);
      const color = slot ? (PLOT_COLOR[slot.status] || PLOT_COLOR.covered) : null;
      if (slot) {
        if (slot.status === 'blank') { // 空白地块：白底 + 虚线描边（与战报卡同语义）
          ctx.fillStyle = '#FFFFFF';
          roundRect(ctx, x, y, cellW, cellH, 8);
          ctx.fill();
          ctx.setLineDash([5, 4]);
          ctx.strokeStyle = C.text3;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          ctx.fillStyle = color;
          roundRect(ctx, x, y, cellW, cellH, 8);
          ctx.fill();
          if (slot.status === 'unique') { ctx.strokeStyle = C.brand; ctx.lineWidth = 1; ctx.stroke(); }
        }
        // 地块文字（最多 2 行截断）
        ctx.save();
        roundRect(ctx, x, y, cellW, cellH, 8);
        ctx.clip();
        ctx.fillStyle = slot.status === 'unique' ? '#FFFFFF' : C.text2;
        ctx.font = `400 11.5px ${FONT}`;
        const lines = wrapText(ctx, slot.argument || '', cellW - 14, 2);
        lines.forEach((line, i) => ctx.fillText(line, x + 7, y + 20 + i * 15));
        ctx.restore();
      } else {
        ctx.fillStyle = C.bg;
        roundRect(ctx, x, y, cellW, cellH, 8);
        ctx.fill();
      }
    }
    y += cellH + cellGap;
  }

  y += 26;

  // ---- 独有增量（最多 3 条） ----
  if (uniqN > 0) {
    ctx.fillStyle = C.text3;
    ctx.font = `400 13px ${FONT}`;
    ctx.fillText('你的独有增量', pad, y - 12);
    y += 14;
    ctx.font = `400 14.5px ${FONT}`;
    for (const text of (inc.unique || []).slice(0, 3)) {
      ctx.fillStyle = C.brandSoft;
      roundRect(ctx, pad, y, 4, 20, 2);
      ctx.fill();
      ctx.fillStyle = C.text;
      for (const line of wrapText(ctx, text, inner - 18, 1)) ctx.fillText(line, pad + 14, y + 15);
      y += 32;
    }
    y += 10;
  }

  // ---- 争议预演（第一条） ----
  const objection = report?.controversy?.objections?.[0];
  if (objection) {
    ctx.fillStyle = C.text3;
    ctx.font = `400 13px ${FONT}`;
    ctx.fillText('争议预演 · 评论区会这么杠', pad, y - 12);
    y += 14;
    ctx.fillStyle = C.redSoft;
    roundRect(ctx, pad, y, inner, 64, 10);
    ctx.fill();
    ctx.fillStyle = C.red;
    ctx.font = `600 13px ${FONT}`;
    for (const line of wrapText(ctx, `「${objection.objection || ''}」`, inner - 32, 1)) ctx.fillText(line, pad + 16, y + 22);
    ctx.fillStyle = C.text2;
    ctx.font = `400 13px ${FONT}`;
    for (const line of wrapText(ctx, `应对：${objection.response || ''}`, inner - 32, 2)) { ctx.fillText(line, pad + 16, y + 42); y += 0; }
    y += 64 + 14;
  }

  // ---- 底部：溯源 + 链接（固定钉在卡片底部） ----
  const footY = H - 24 - 72;
  ctx.strokeStyle = C.divider;
  ctx.beginPath();
  ctx.moveTo(pad, footY - 20);
  ctx.lineTo(W - pad, footY - 20);
  ctx.stroke();
  ctx.fillStyle = C.text3;
  ctx.font = `400 12px ${FONT}`;
  const trace = '判断依据：社区排序 / 站内检索 / 真实评论 · 每条结论标注证据等级';
  ctx.fillText(trace, pad, footY);
  const time = report?.trace?.generated_at ? new Date(report.trace.generated_at).toLocaleDateString('zh-CN') : '';
  if (time) {
    const timeText = `· ${time}`;
    ctx.fillText(timeText, W - pad - ctx.measureText(timeText).width, footY);
  }
  ctx.fillStyle = C.brand;
  ctx.font = `600 15px ${FONT}`;
  const urlText = reportUrl || (runId ? `/?report=${runId}` : 'soundcheck');
  ctx.fillText(`开麦前先试麦 → ${urlText}`, pad, footY + 34);

  return canvas;
}

/** 下载 PNG（toBlob → objectURL → a[download]） */
export function downloadPoster(canvas, filename) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, 'image/png');
}
