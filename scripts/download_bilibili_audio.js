#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const inputUrl = process.argv[2] || process.env.BILI_URL || '';
const ytDlp = process.env.BILI_YTDLP || 'yt-dlp';
const scope = (process.env.BILI_SCOPE || 'input').toLowerCase();
const outputRoot = process.env.BILI_OUTPUT_ROOT || path.join(ROOT, 'data', 'bilibili');
const explicitOutputDir = process.env.BILI_OUTPUT_DIR || '';
const maxVideos = Number(process.env.BILI_MAX_VIDEOS || '0');
const startIndex = Math.max(1, Number(process.env.BILI_START_INDEX || '1'));
const skipDownload = process.env.BILI_SKIP_DOWNLOAD === '1';
const overwrite = process.env.BILI_OVERWRITE === '1';
const format = process.env.BILI_FORMAT || 'bestaudio/best';
const audioFormat = process.env.BILI_AUDIO_FORMAT || 'm4a';
const audioQuality = process.env.BILI_AUDIO_QUALITY || '0';

if (!inputUrl) {
  console.error('Usage: node scripts/download_bilibili_audio.js <bilibili video/space URL>');
  console.error('Useful env: BILI_SCOPE=uploader, BILI_MAX_VIDEOS=10, BILI_OUTPUT_DIR=data/bilibili/name');
  process.exit(2);
}

function sanitizeFilename(value, fallback = 'untitled') {
  const text = String(value || fallback)
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return text || fallback;
}

function slugFor(value) {
  const text = String(value || '')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return text || 'bilibili';
}

function dateFromInfo(info) {
  const uploadDate = String(info?.upload_date || '');
  if (/^\d{8}$/.test(uploadDate)) {
    return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`;
  }
  if (info?.timestamp) {
    return new Date(Number(info.timestamp) * 1000).toISOString().slice(0, 10);
  }
  return 'unknown-date';
}

function isoFromInfo(info) {
  if (info?.timestamp) return new Date(Number(info.timestamp) * 1000).toISOString();
  const date = dateFromInfo(info);
  return date === 'unknown-date' ? '' : `${date}T00:00:00.000Z`;
}

function cookiesArgs() {
  if (process.env.BILI_COOKIES_FILE) return ['--cookies', process.env.BILI_COOKIES_FILE];
  const fromBrowser = process.env.BILI_COOKIES_FROM_BROWSER ?? 'chrome';
  if (!fromBrowser || fromBrowser === '0' || fromBrowser.toLowerCase() === 'none') return [];
  return ['--cookies-from-browser', fromBrowser];
}

function commonArgs() {
  return ['--no-warnings', '--no-update', ...cookiesArgs()];
}

function run(command, args, options = {}) {
  const capture = Boolean(options.capture);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    });

    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
    }

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const detail = capture ? `\n${stderr || stdout}`.trimEnd() : '';
        reject(new Error(`${command} exited with code ${code}${detail ? `: ${detail}` : ''}`));
      }
    });
  });
}

async function ytDlpJson(args) {
  const { stdout } = await run(ytDlp, [...commonArgs(), ...args], { capture: true });
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error('yt-dlp returned empty JSON output');
  return JSON.parse(trimmed);
}

function isSpaceUrl(url) {
  return /space\.bilibili\.com\/\d+/i.test(url);
}

async function resolveRootUrl(url) {
  if (scope !== 'uploader' && scope !== 'space') return url;
  if (isSpaceUrl(url)) return url;

  const info = await ytDlpJson(['--dump-single-json', '--skip-download', '--no-playlist', url]);
  const uploaderId = info.uploader_id || info.channel_id || info.uploader_url?.match(/space\.bilibili\.com\/(\d+)/)?.[1];
  if (!uploaderId) {
    throw new Error('Could not infer Bilibili uploader id from the seed video. Pass a space URL instead.');
  }
  return `https://space.bilibili.com/${uploaderId}/video`;
}

function entryUrl(entry) {
  if (entry?.url?.startsWith('http')) return entry.url;
  if (entry?.id) return `https://www.bilibili.com/video/${entry.id}`;
  return '';
}

function selectEntries(rootInfo, fallbackUrl) {
  if (rootInfo?._type === 'playlist' && Array.isArray(rootInfo.entries)) {
    const entries = rootInfo.entries.map(entryUrl).filter(Boolean);
    const selected = entries.slice(startIndex - 1, maxVideos > 0 ? startIndex - 1 + maxVideos : undefined);
    return selected.map((url, offset) => ({ url, index: startIndex + offset }));
  }

  return [{ url: fallbackUrl, index: 1 }];
}

function outputDirFor(rootInfo) {
  if (explicitOutputDir) return path.resolve(ROOT, explicitOutputDir);
  const id = rootInfo?.id || rootInfo?.uploader_id || rootInfo?.channel_id || 'bilibili';
  const label = rootInfo?.uploader || rootInfo?.title || id;
  return path.join(outputRoot, `${slugFor(label)}-${slugFor(id)}`);
}

function compactRawInfo(info) {
  const {
    formats,
    requested_formats: requestedFormats,
    requested_downloads: requestedDownloads,
    http_headers: httpHeaders,
    automatic_captions: automaticCaptions,
    ...rest
  } = info || {};
  return {
    ...rest,
    formatCount: Array.isArray(formats) ? formats.length : 0,
    requestedFormatCount: Array.isArray(requestedFormats) ? requestedFormats.length : 0,
    requestedDownloadCount: Array.isArray(requestedDownloads) ? requestedDownloads.length : 0,
    hasAutomaticCaptions: Boolean(automaticCaptions && Object.keys(automaticCaptions).length),
    hasHttpHeaders: Boolean(httpHeaders && Object.keys(httpHeaders).length),
  };
}

function targetStemFor(info, index, audioDir) {
  const ordinal = String(index).padStart(3, '0');
  const date = dateFromInfo(info);
  const id = sanitizeFilename(info.id || info.display_id || 'unknown-id', 'unknown-id');
  const title = sanitizeFilename(info.title || info.fulltitle || id);
  return path.join(audioDir, `${ordinal}-${date}-${title} [${id}]`);
}

function findDownloadedAudio(targetStem) {
  const dir = path.dirname(targetStem);
  const prefix = path.basename(targetStem);
  if (!fs.existsSync(dir)) return '';

  const audioExts = new Set(['.m4a', '.mp3', '.opus', '.ogg', '.webm', '.wav', '.flac', '.aac', '.mp4']);
  const candidates = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .filter((name) => !name.endsWith('.info.json'))
    .filter((name) => !name.endsWith('.part') && !name.endsWith('.ytdl'))
    .map((name) => path.join(dir, name))
    .filter((file) => {
      const stat = fs.existsSync(file) ? fs.statSync(file) : null;
      return stat?.isFile() && audioExts.has(path.extname(file).toLowerCase());
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  return candidates[0] || '';
}

function normalizeVideo(info, index, audioFile, status) {
  const stat = audioFile && fs.existsSync(audioFile) ? fs.statSync(audioFile) : null;
  const webpageUrl = info.webpage_url || info.original_url || (info.id ? `https://www.bilibili.com/video/${info.id}` : '');
  const ext = audioFile ? path.extname(audioFile).slice(1).toLowerCase() : audioFormat;
  return {
    index,
    source: 'bilibili',
    id: info.id || info.display_id || '',
    bvid: info.id || info.display_id || '',
    uploader: info.uploader || '',
    uploaderId: info.uploader_id || '',
    title: info.title || info.fulltitle || '',
    pubDate: isoFromInfo(info),
    uploadDate: dateFromInfo(info),
    duration: Number(info.duration || 0),
    description: info.description || '',
    tags: Array.isArray(info.tags) ? info.tags : [],
    thumbnail: info.thumbnail || '',
    webpageUrl,
    episodeUrl: webpageUrl,
    viewCount: info.view_count || 0,
    likeCount: info.like_count || 0,
    commentCount: info.comment_count || 0,
    mediaSize: stat?.size || 0,
    mimeType: ext === 'm4a' ? 'audio/mp4' : `audio/${ext || 'unknown'}`,
    audioFile: audioFile ? path.resolve(audioFile) : '',
    status,
  };
}

function toCsv(rows) {
  const columns = [
    'index',
    'source',
    'id',
    'uploader',
    'uploaderId',
    'title',
    'pubDate',
    'duration',
    'webpageUrl',
    'audioFile',
    'status',
  ];
  const escape = (value) => {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `${[columns.join(','), ...rows.map((row) => columns.map((column) => escape(row[column])).join(','))].join('\n')}\n`;
}

async function downloadAudio(info, index, audioDir) {
  const targetStem = targetStemFor(info, index, audioDir);
  const existing = findDownloadedAudio(targetStem);
  if (existing && !overwrite) return { audioFile: existing, status: 'exists' };

  const args = [
    ...commonArgs(),
    '--no-playlist',
    '--extract-audio',
    '--audio-format',
    audioFormat,
    '--audio-quality',
    audioQuality,
    '-f',
    format,
    '--write-info-json',
    overwrite ? '--force-overwrites' : '--no-overwrites',
    '-o',
    `${targetStem}.%(ext)s`,
    info.webpage_url || info.original_url || `https://www.bilibili.com/video/${info.id}`,
  ];

  await run(ytDlp, args);
  const audioFile = findDownloadedAudio(targetStem);
  if (!audioFile) throw new Error(`download finished but no audio file matched ${targetStem}.*`);
  return { audioFile, status: 'downloaded' };
}

async function main() {
  await run(ytDlp, ['--version'], { capture: true });

  const rootUrl = await resolveRootUrl(inputUrl);
  const rootInfo = await ytDlpJson(['--flat-playlist', '--dump-single-json', '--skip-download', rootUrl]);
  const selected = selectEntries(rootInfo, rootUrl);
  const catalogDir = outputDirFor(rootInfo);
  const audioDir = path.join(catalogDir, 'audio');

  fs.mkdirSync(audioDir, { recursive: true });

  console.log(`Input: ${inputUrl}`);
  console.log(`Resolved root: ${rootUrl}`);
  console.log(`Output: ${catalogDir}`);
  console.log(`Selected videos: ${selected.length}`);
  console.log(`Cookies: ${cookiesArgs().length ? cookiesArgs().join(' ') : 'none'}`);
  console.log(`Skip download: ${skipDownload}`);

  const rawInfos = [];
  const manifest = [];
  const failures = [];
  let downloaded = 0;
  let skipped = 0;

  for (const item of selected) {
    const label = `${String(item.index).padStart(3, '0')} ${item.url}`;
    try {
      console.log(`[meta] ${label}`);
      const info = await ytDlpJson(['--dump-single-json', '--skip-download', '--no-playlist', item.url]);
      rawInfos.push(compactRawInfo(info));

      let audioFile = '';
      let status = 'metadata-only';
      if (!skipDownload) {
        console.log(`[down] ${String(item.index).padStart(3, '0')} ${info.title || info.id}`);
        const result = await downloadAudio(info, item.index, audioDir);
        audioFile = result.audioFile;
        status = result.status;
        if (status === 'downloaded') downloaded += 1;
        if (status === 'exists') skipped += 1;
      }

      manifest.push(normalizeVideo(info, item.index, audioFile, status));
    } catch (error) {
      failures.push({ index: item.index, url: item.url, error: error.message });
      manifest.push({ index: item.index, source: 'bilibili', webpageUrl: item.url, status: 'failed', error: error.message });
      console.error(`[fail] ${label}: ${error.message}`);
    }
  }

  const summary = {
    finishedAt: new Date().toISOString(),
    inputUrl,
    rootUrl,
    scope,
    catalogDir,
    audioDir,
    selectedCount: selected.length,
    downloadedCount: downloaded,
    skippedExistingCount: skipped,
    failureCount: failures.length,
    failures,
  };

  fs.writeFileSync(path.join(catalogDir, 'videos.raw.json'), `${JSON.stringify(rawInfos, null, 2)}\n`);
  fs.writeFileSync(path.join(catalogDir, 'videos.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(catalogDir, 'videos.csv'), toCsv(manifest));
  fs.writeFileSync(path.join(catalogDir, 'audio-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(catalogDir, 'download-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  console.log('\nDone.');
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
