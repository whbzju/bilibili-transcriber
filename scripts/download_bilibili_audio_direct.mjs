#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

const inputUrl = process.argv[2] || process.env.BILI_URL || '';
const outputDir = path.resolve(ROOT, process.env.BILI_OUTPUT_DIR || 'data/bilibili/direct-download');
const audioDir = path.join(outputDir, 'audio');
const overwrite = process.env.BILI_OVERWRITE === '1';
const audioFormat = process.env.BILI_AUDIO_FORMAT || 'm4a';

const headers = {
  'user-agent':
    process.env.BILI_USER_AGENT ||
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
  referer: 'https://www.bilibili.com/',
  accept: '*/*',
};

if (!inputUrl) {
  console.error('Usage: node scripts/download_bilibili_audio_direct.mjs <bilibili video URL or BV id>');
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

function extractBvid(value) {
  return String(value || '').match(/BV[a-zA-Z0-9]{8,}/)?.[0] || '';
}

function dateFromTimestamp(timestamp) {
  if (!timestamp) return 'unknown-date';
  return new Date(Number(timestamp) * 1000).toISOString().slice(0, 10);
}

function isoFromTimestamp(timestamp) {
  return timestamp ? new Date(Number(timestamp) * 1000).toISOString() : '';
}

function timestamp(seconds) {
  const safe = Math.max(0, Number(seconds || 0));
  const whole = Math.floor(safe);
  const ms = Math.round((safe - whole) * 1000);
  const h = String(Math.floor(whole / 3600)).padStart(2, '0');
  const m = String(Math.floor((whole % 3600) / 60)).padStart(2, '0');
  const s = String(whole % 60).padStart(2, '0');
  return `${h}:${m}:${s}.${String(ms).padStart(3, '0')}`;
}

function srtTimestamp(seconds) {
  return timestamp(seconds).replace('.', ',');
}

async function fetchText(url) {
  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  const payload = await response.json();
  if (payload && payload.code && payload.code !== 0) {
    throw new Error(`Bilibili API ${payload.code}: ${payload.message || url}`);
  }
  return payload;
}

async function normalizeInput(value) {
  const input = String(value || '').trim();
  const directBvid = extractBvid(input);
  if (directBvid) return { url: `https://www.bilibili.com/video/${directBvid}/`, bvid: directBvid };
  if (/^https?:\/\/b23\.tv\//i.test(input)) {
    const response = await fetch(input, { headers, redirect: 'follow' });
    const finalUrl = response.url || input;
    const bvid = extractBvid(finalUrl);
    if (bvid) return { url: finalUrl, bvid };
  }
  throw new Error('Direct downloader only supports single Bilibili video URLs or BV ids.');
}

async function loadViewInfo(url, bvid) {
  try {
    const payload = await fetchJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
    if (payload?.data?.pages?.length) return payload.data;
  } catch (error) {
    console.error(`[warn] x/web-interface/view failed: ${error.message}`);
  }

  const html = await fetchText(url);
  const match = html.match(/window\.__INITIAL_STATE__=(.*?);\(function\(\)/s) || html.match(/__INITIAL_STATE__=(.*?);<\/script>/s);
  if (!match) throw new Error('Could not parse __INITIAL_STATE__ from Bilibili page.');
  const state = JSON.parse(match[1]);
  const videoData = state.videoData || state.videoInfo || state;
  if (!videoData?.pages?.length) throw new Error('Bilibili page did not include video pages.');
  return videoData;
}

async function downloadFile(url, target) {
  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} while downloading ${url}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const file = fs.createWriteStream(target);
  await new Promise((resolve, reject) => {
    response.body.pipeTo(
      new WritableStream({
        write(chunk) {
          file.write(Buffer.from(chunk));
        },
        close() {
          file.end(resolve);
        },
        abort(error) {
          file.destroy(error);
          reject(error);
        },
      }),
    ).catch(reject);
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function convertM4sToM4a(source, target) {
  if (audioFormat !== 'm4a') return source;
  if (fs.existsSync(target) && !overwrite) return target;
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-vn', '-c:a', 'copy', target]);
    return target;
  } catch (error) {
    console.error(`[warn] ffmpeg copy to m4a failed, keeping m4s: ${error.message}`);
    return source;
  }
}

async function saveOfficialSubtitles(view, page, item, baseStem) {
  const aid = view.aid;
  const cid = page.cid;
  const subtitleDir = path.join(outputDir, 'official-subtitles');
  try {
    const payload = await fetchJson(
      `https://api.bilibili.com/x/player/v2?aid=${encodeURIComponent(aid)}&cid=${encodeURIComponent(cid)}`,
    );
    const subtitles = payload?.data?.subtitle?.subtitles || [];
    if (!subtitles.length) return [];

    fs.mkdirSync(subtitleDir, { recursive: true });
    const saved = [];
    for (const [idx, subtitle] of subtitles.entries()) {
      const rawUrl = subtitle.subtitle_url || subtitle.subtitleUrl || '';
      if (!rawUrl) continue;
      const subtitleUrl = rawUrl.startsWith('http') ? rawUrl : `https:${rawUrl}`;
      const data = await fetchJson(subtitleUrl);
      const body = Array.isArray(data.body) ? data.body : [];
      const suffix = `${idx + 1}-${sanitizeFilename(subtitle.lan_doc || subtitle.lan || 'subtitle')}`;
      const jsonFile = path.join(subtitleDir, `${path.basename(baseStem)}.${suffix}.json`);
      const srtFile = jsonFile.replace(/\.json$/, '.srt');
      const txtFile = jsonFile.replace(/\.json$/, '.txt');
      fs.writeFileSync(jsonFile, `${JSON.stringify({ episode: item, subtitle, body }, null, 2)}\n`);
      fs.writeFileSync(txtFile, `${body.map((row) => row.content).filter(Boolean).join('\n')}\n`);
      const srt = body
        .map((row, rowIdx) =>
          [
            String(rowIdx + 1),
            `${srtTimestamp(row.from)} --> ${srtTimestamp(row.to)}`,
            row.content || '',
            '',
          ].join('\n'),
        )
        .join('\n');
      fs.writeFileSync(srtFile, srt);
      saved.push({ jsonFile, srtFile, txtFile, language: subtitle.lan, languageDoc: subtitle.lan_doc });
    }
    return saved;
  } catch (error) {
    console.error(`[warn] official subtitle fetch failed for cid ${cid}: ${error.message}`);
    return [];
  }
}

function targetStem(view, page, index) {
  const ordinal = String(index).padStart(3, '0');
  const date = dateFromTimestamp(view.pubdate || view.ctime);
  const id = page.page && page.page > 1 ? `${view.bvid}-p${page.page}` : view.bvid;
  const title = page.part && page.part !== view.title ? `${view.title} - ${page.part}` : view.title;
  return path.join(audioDir, `${ordinal}-${date}-${sanitizeFilename(title)} [${sanitizeFilename(id)}]`);
}

async function downloadPage(view, page, index, url) {
  const stem = targetStem(view, page, index);
  const tmp = `${stem}.m4s`;
  const finalM4a = `${stem}.m4a`;
  const finalAudio = fs.existsSync(finalM4a) && !overwrite ? finalM4a : fs.existsSync(tmp) && !overwrite ? tmp : '';

  let audioFile = finalAudio;
  if (!audioFile) {
    const play = await fetchJson(
      `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(view.bvid)}&cid=${encodeURIComponent(
        page.cid,
      )}&qn=16&fnval=16&fourk=0`,
    );
    const audios = play?.data?.dash?.audio || [];
    if (!audios.length) throw new Error(`No DASH audio stream for ${view.bvid} cid=${page.cid}`);
    const best = audios.toSorted((a, b) => Number(b.bandwidth || 0) - Number(a.bandwidth || 0))[0];
    const audioUrl = best.baseUrl || best.base_url;
    if (!audioUrl) throw new Error(`Audio stream did not include a URL for ${view.bvid} cid=${page.cid}`);
    console.log(`[direct] downloading audio cid=${page.cid}`);
    await downloadFile(audioUrl, tmp);
    audioFile = await convertM4sToM4a(tmp, finalM4a);
  }

  const item = {
    index,
    source: 'bilibili',
    id: view.bvid,
    bvid: view.bvid,
    aid: view.aid,
    cid: page.cid,
    uploader: view.owner?.name || '',
    uploaderId: view.owner?.mid ? String(view.owner.mid) : '',
    title: page.part && page.part !== view.title ? `${view.title} - ${page.part}` : view.title,
    pubDate: isoFromTimestamp(view.pubdate || view.ctime),
    uploadDate: dateFromTimestamp(view.pubdate || view.ctime),
    duration: Number(page.duration || view.duration || 0),
    description: view.desc || '',
    tags: [],
    thumbnail: view.pic || '',
    webpageUrl: url,
    episodeUrl: url,
    viewCount: view.stat?.view || 0,
    likeCount: view.stat?.like || 0,
    commentCount: view.stat?.reply || 0,
    mediaSize: fs.statSync(audioFile).size,
    mimeType: audioFile.endsWith('.m4a') ? 'audio/mp4' : 'audio/m4s',
    audioFile: path.resolve(audioFile),
    status: fs.existsSync(finalAudio) ? 'exists' : 'downloaded',
    downloader: 'bilibili-direct-api',
  };

  const officialSubtitles = await saveOfficialSubtitles(view, page, item, stem);
  item.officialSubtitles = officialSubtitles;
  const infoFile = `${stem}.info.json`;
  fs.writeFileSync(infoFile, `${JSON.stringify({ ...view, currentPage: page, directDownloader: true }, null, 2)}\n`);
  return item;
}

function toCsv(rows) {
  const columns = ['index', 'source', 'id', 'uploader', 'uploaderId', 'title', 'pubDate', 'duration', 'webpageUrl', 'audioFile', 'status'];
  const escape = (value) => {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `${[columns.join(','), ...rows.map((row) => columns.map((column) => escape(row[column])).join(','))].join('\n')}\n`;
}

async function main() {
  const normalized = await normalizeInput(inputUrl);
  const view = await loadViewInfo(normalized.url, normalized.bvid);
  fs.mkdirSync(audioDir, { recursive: true });

  console.log(`Input: ${inputUrl}`);
  console.log(`Resolved video: ${normalized.url}`);
  console.log(`Output: ${outputDir}`);
  console.log(`Title: ${view.title}`);
  console.log(`Pages: ${view.pages.length}`);

  const manifest = [];
  const failures = [];
  for (const [idx, page] of view.pages.entries()) {
    try {
      manifest.push(await downloadPage(view, page, idx + 1, normalized.url));
    } catch (error) {
      failures.push({ index: idx + 1, cid: page.cid, error: error.message });
      console.error(`[fail] page ${idx + 1}: ${error.message}`);
    }
  }

  const summary = {
    finishedAt: new Date().toISOString(),
    inputUrl,
    rootUrl: normalized.url,
    scope: 'input',
    catalogDir: outputDir,
    audioDir,
    selectedCount: view.pages.length,
    downloadedCount: manifest.filter((item) => item.status === 'downloaded').length,
    skippedExistingCount: manifest.filter((item) => item.status === 'exists').length,
    officialSubtitleCount: manifest.reduce((sum, item) => sum + (item.officialSubtitles?.length || 0), 0),
    failureCount: failures.length,
    failures,
    downloader: 'bilibili-direct-api',
  };

  fs.writeFileSync(path.join(outputDir, 'videos.raw.json'), `${JSON.stringify([view], null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, 'videos.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, 'videos.csv'), toCsv(manifest));
  fs.writeFileSync(path.join(outputDir, 'audio-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, 'download-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  console.log('\nDone.');
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
