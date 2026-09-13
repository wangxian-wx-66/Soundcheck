import { execFile } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

function execFileResult(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { ...options, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => resolve({
      ok: !error,
      stdout: stdout?.toString().trim() || '',
      stderr: stderr?.toString().trim() || '',
    }));
  });
}

function configPathFromArgs() {
  const index = process.argv.indexOf('--project-dir');
  return index >= 0 && process.argv[index + 1]
    ? path.join(path.resolve(process.argv[index + 1]), 'hackathon.config.json')
    : null;
}

function isPublicHttps(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const local = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1' || hostname === '0.0.0.0' ||
      /^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname) ||
      (() => { const match = hostname.match(/^172\.(\d{1,3})\./); return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31); })();
    return url.protocol === 'https:' && !local && url.pathname.endsWith('/auth/callback');
  } catch {
    return false;
  }
}

try {
  const configPath = configPathFromArgs();
  if (!configPath) throw new Error('Required: --project-dir.');
  const projectDir = path.dirname(configPath);
  const configText = await readFile(configPath, 'utf8');
  const config = JSON.parse(configText);
  const requiredFiles = ['server.mjs', 'public/index.html', 'public/styles.css', '.codex/skills/zhihu/SKILL.md'];
  if (config.oauth?.enabled === true) requiredFiles.push('public/app.js', 'lib/oauth.mjs');
  const fileChecks = await Promise.all(requiredFiles.map(async (file) => {
    try {
      await access(path.join(projectDir, file));
      return [file, true];
    } catch {
      return [file, false];
    }
  }));

  const appKey = config.oauth?.enabled === true
    ? await execFileResult('/usr/bin/security', [
        'find-generic-password',
        '-s',
        config.oauth.credentialService,
        '-a',
        config.oauth.credentialAccount,
        '-w',
      ])
    : { ok: false };
  const runScript = path.join(projectDir, '.codex', 'skills', 'zhihu', 'scripts', 'run.sh');
  const officialStatus = await execFileResult('/bin/bash', [runScript, 'status'], { cwd: projectDir });
  let status = null;
  try { status = JSON.parse(officialStatus.stdout); } catch { status = null; }
  const topLevel = await readdir(projectDir);
  const configTextForScan = JSON.stringify(config);
  const unsafeConfigKeys = ['appKey', 'accessSecret', 'accessToken', 'authorizationCode'].filter((key) =>
    new RegExp(`"${key}"`, 'i').test(configTextForScan),
  );

  const appKeyConfigured = config.oauth?.enabled === true
    ? Boolean(process.env.ZHIHU_OAUTH_APP_KEY) || appKey.ok
    : false;
  const accessSecretConfigured = Boolean(process.env.ZHIHU_ACCESS_SECRET) ||
    status?.auth?.configured === true || status?.auth?.source === 'keychain';
  const report = {
    ok: true,
    projectDir,
    files: Object.fromEntries(fileChecks),
    configuration: {
      oauthEnabled: config.oauth?.enabled === true,
      appId: config.oauth?.enabled === true ? Boolean(config.oauth.appId) : null,
      redirectUri: config.oauth?.enabled === true ? isPublicHttps(config.oauth.redirectUri) : null,
      localPreviewOnly: config.oauth?.enabled === true ? !isPublicHttps(config.oauth.redirectUri) : null,
      unsafeConfigKeys,
      dotEnvPresent: topLevel.some((name) => name === '.env' || name.startsWith('.env.')),
    },
    appKey: config.oauth?.enabled === true
      ? { required: true, configured: appKeyConfigured, storage: process.env.ZHIHU_OAUTH_APP_KEY ? 'deployment secret' : 'macOS Keychain' }
      : { required: false, configured: false, storage: null },
    accessSecret: {
      configured: accessSecretConfigured,
      source: process.env.ZHIHU_ACCESS_SECRET ? 'deployment secret' : status?.auth?.source ?? null,
    },
    cli: { installed: status?.installed ?? null, compatible: status?.compatible ?? null },
  };
  report.readyForLocalPreview =
    Object.values(report.files).every(Boolean) &&
    report.configuration.unsafeConfigKeys.length === 0 &&
    !report.configuration.dotEnvPresent &&
    report.cli.installed === true &&
    report.cli.compatible !== false;
  report.readyForOAuth =
    report.readyForLocalPreview &&
    (!report.configuration.oauthEnabled || report.configuration.redirectUri === true) &&
    (!report.appKey.required || report.appKey.configured) &&
    report.accessSecret.configured === true;
  report.ready = report.readyForOAuth;
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, ready: false, error: error.message })}\n`);
  process.exit(1);
}
