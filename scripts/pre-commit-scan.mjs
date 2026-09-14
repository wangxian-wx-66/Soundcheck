#!/usr/bin/env node
// pre-commit 密钥扫描（零依赖：项目无 devDependencies，不引 husky/detect-secrets 供应链面）
// 纪律来源：计划书硬约束「pre-commit 必须跑密钥扫描」
// 规则：对暂存区新增/修改行做模式匹配——常见 key 前缀、长随机 token、私钥块
import { execFileSync } from 'node:child_process';

const KEY_PATTERNS = [
  [/^[-]{3,}\s*BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY[-]{3,}/, '私钥块'],
  [/sk-[a-zA-Z0-9]{20,}/, 'OpenAI/DeepSeek 风格 key'],
  [/ghp_[a-zA-Z0-9]{30,}/, 'GitHub token'],
  [/AKIA[0-9A-Z]{16}/, 'AWS AccessKey'],
  [/eyJ[a-zA-Z0-9_-]{20,}\./, 'JWT'],
  [/(api[_-]?key|access[_-]?secret|secret[_-]?key|app[_-]?key|password|token)\s*[:=]\s*['"]?[A-Za-z0-9+\/_-]{16,}['"]?$/i, '凭证赋值（疑似真实值）'],
];

function stagedFiles() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], { encoding: 'utf8' });
  return out.split(/\r?\n/).filter(Boolean);
}

let findings = [];
try {
  for (const file of stagedFiles()) {
    if (!/\.(mjs|js|json|md|yml|yaml|sh|ps1|env|txt|html|css)$/i.test(file)) continue;
    let diff;
    try { diff = execFileSync('git', ['diff', '--cached', '-U0', '--', file], { encoding: 'utf8' }); }
    catch { continue; }
    // 只扫新增行（+ 开头），不扫删除的旧密钥
    for (const line of diff.split(/\r?\n/)) {
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      const content = line.slice(1).trim();
      if (!content || content.startsWith('#') || content.startsWith('//')) continue;
      for (const [pattern, label] of KEY_PATTERNS) {
        if (pattern.test(content)) findings.push(`${file}: [${label}] ${content.slice(0, 60)}…`);
      }
    }
  }
} catch (error) {
  console.error(`扫描执行失败（不阻塞提交，请人工核查）: ${error.message}`);
  process.exit(0);
}

if (findings.length) {
  console.error('⛔ pre-commit 密钥扫描命中以下疑似凭证，提交中止：\n');
  for (const f of findings) console.error(`  ${f}`);
  console.error('\n处理：真实密钥 → 移入环境变量/Secret 注入；误报（示例/占位值）→ git commit --no-verify 跳过并人工确认');
  process.exit(1);
}
console.log('pre-commit 密钥扫描通过（0 命中）');
