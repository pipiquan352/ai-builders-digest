#!/usr/bin/env node

// CI-compatible daily updater for GitHub Actions.
// Uses Anthropic API for translations if ANTHROPIC_API_KEY is set,
// otherwise falls back to Google Translate.
// Sends email via Resend if RESEND_API_KEY is set.

import { writeFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_DIR = join(__dirname, '..');
const DATA_DIR = join(SITE_DIR, 'data');

const FEED_X_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json';
const FEED_PODCASTS_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json';
const EXCLUDE_HANDLES = ['zarazhangrui'];

// -- Fetch JSON ---------------------------------------------------------------

async function fetchJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error(`Failed to fetch ${url}: ${e.message}`);
    return null;
  }
}

// -- Translation: Anthropic API -----------------------------------------------

async function translateWithClaude(builders, podcasts) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const digest = { x: {}, podcasts: {} };

  // Batch X builders
  const batchSize = 8;
  for (let i = 0; i < builders.length; i += batchSize) {
    const batch = builders.slice(i, i + batchSize);
    const buildersText = batch.map(b => {
      const tweet = summarizeTweet(b);
      return tweet ? `@${b.handle} (${b.name}): ${tweet}` : null;
    }).filter(Boolean).join('\n\n');

    if (!buildersText) continue;
    console.log(`  Claude: batch ${i + 1}-${Math.min(i + batchSize, builders.length)}...`);

    const prompt = `Summarize each AI builder's tweet for a bilingual digest. Write a concise 1-2 sentence English summary and natural Chinese translation (keep tech terms and names in English).

${buildersText}

Return ONLY a JSON object (no markdown, no fences) like: {"handle1":{"en":"...","zh":"..."},"handle2":{"en":"...","zh":"..."}}`;

    try {
      const result = await callClaude(apiKey, prompt);
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) Object.assign(digest.x, JSON.parse(jsonMatch[0]));
    } catch (e) {
      console.error(`  Claude failed for batch: ${e.message}`);
      return null; // fall back to Google Translate for everything
    }
  }

  // Podcasts
  for (const p of podcasts) {
    if (!p.transcript) continue;
    console.log(`  Claude: podcast ${p.name}...`);
    const transcript = p.transcript.slice(0, 12000);
    const prompt = `Summarize this podcast for a bilingual AI industry digest.

Podcast: ${p.name}
Episode: "${p.title}"
Transcript: ${transcript}

Return ONLY a JSON object (no markdown, no fences):
{"en":"3-4 sentence English summary with key insights","zh":"Chinese translation, keep technical terms and proper nouns in English","takeaway_en":"One bold sentence takeaway","takeaway_zh":"Chinese translation of takeaway"}`;

    try {
      const result = await callClaude(apiKey, prompt);
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) digest.podcasts[p.name] = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error(`  Claude failed for podcast: ${e.message}`);
    }
  }

  return digest;
}

async function callClaude(apiKey, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.content[0].text;
}

// -- Translation: Google Translate fallback -----------------------------------

async function translateWithGoogle(builders, podcasts) {
  const digest = { x: {}, podcasts: {} };

  for (const b of builders) {
    const en = summarizeTweet(b);
    if (!en) continue;
    const zh = await googleTranslate(en);
    digest.x[b.handle] = { en, zh };
    await sleep(300);
  }

  for (const p of podcasts) {
    if (!p.transcript) continue;
    const snippet = p.transcript.slice(0, 500);
    const zh = await googleTranslate(snippet);
    digest.podcasts[p.name] = { en: snippet + '...', zh, takeaway_en: '', takeaway_zh: '' };
  }

  return digest;
}

async function googleTranslate(text) {
  if (!text) return '';
  try {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=' + encodeURIComponent(text);
    const res = await fetch(url);
    const data = await res.json();
    return data[0].map(s => s[0]).join('');
  } catch {
    return '';
  }
}

// -- Helpers ------------------------------------------------------------------

function summarizeTweet(builder) {
  if (!builder.tweets || builder.tweets.length === 0) return '';
  const sorted = [...builder.tweets].sort((a, b) => (b.likes + b.retweets) - (a.likes + a.retweets));
  return sorted[0].text.replace(/https:\/\/t\.co\/\S+/g, '').trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// -- Email delivery via Resend ------------------------------------------------

async function sendEmail(digestPath, rawPath) {
  const apiKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.RESEND_TO_EMAIL;
  if (!apiKey || !toEmail) {
    console.log('Email: skipped (no RESEND_API_KEY or RESEND_TO_EMAIL)');
    return;
  }

  const digest = JSON.parse(await readFile(digestPath, 'utf-8'));
  const raw = JSON.parse(await readFile(rawPath, 'utf-8'));

  // Build plain text digest for email
  const lines = [];
  lines.push('AI Builders Digest');
  lines.push('');

  // X builders
  const xEntries = Object.entries(digest.x);
  for (const [handle, summary] of xEntries) {
    const builder = raw.x?.find(b => b.handle === handle);
    const name = builder?.name || handle;
    lines.push(`**${name} (@${handle})**`);
    lines.push(summary.en);
    if (summary.zh) lines.push(summary.zh);
    if (builder?.tweets?.[0]) {
      lines.push(`https://x.com/${handle}/status/${builder.tweets[0].id}`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // Podcasts
  const podEntries = Object.entries(digest.podcasts);
  if (podEntries.length > 0) {
    lines.push('## PODCAST HIGHLIGHTS');
    lines.push('');
    for (const [name, summary] of podEntries) {
      lines.push(`### ${name}`);
      if (summary.takeaway_en) lines.push(`**The Takeaway:** ${summary.takeaway_en}`);
      if (summary.takeaway_zh) lines.push(summary.takeaway_zh);
      lines.push('');
    }
  }

  const text = lines.join('\n');
  const html = buildEmailHtml(text);
  const toAddresses = toEmail.split(',').map(e => e.trim());

  console.log(`Email: sending to ${toAddresses.join(', ')}...`);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      from: 'AI Builders Digest <digest@mengyuan-pi.xyz>',
      to: toAddresses,
      subject: `AI Builders Digest - ${new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      })}`,
      html,
      text
    })
  });

  if (!res.ok) {
    const err = await res.json();
    console.error(`Email failed: ${err.message || JSON.stringify(err)}`);
  } else {
    const result = await res.json();
    console.log(`Email sent: ${result.id}`);
  }
}

function buildEmailHtml(text) {
  const SITE_URL = 'https://pipiquan352.github.io/ai-builders-digest/';
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const font = 'Segoe UI,Calibri,-apple-system,Arial,sans-serif';

  const blocks = text.split(/\n---\n/).map(b => b.trim()).filter(Boolean);
  const cards = [];
  let podcastCard = null;

  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    if (lines[0].startsWith('AI Builders Digest')) continue;

    if (lines[0].startsWith('## ') && lines[0].includes('PODCAST')) {
      const rest = lines.slice(1);
      for (const line of rest) {
        if (line.startsWith('**The Takeaway:')) podcastCard = { takeawayEn: line.replace(/\*\*/g, ''), takeawayZh: '' };
        if (/[\u4e00-\u9fff]/.test(line) && podcastCard) podcastCard.takeawayZh = line;
      }
      continue;
    }

    let nameLine = '', enParts = [], zh = '', url = '';
    for (const line of lines) {
      if (line.match(/^https?:\/\//)) { if (!url) url = line; continue; }
      if (line.startsWith('**') && !nameLine) {
        const match = line.match(/^\*\*(.+?)\*\*\s*(.*)/);
        if (match) { nameLine = match[1]; if (match[2]) enParts.push(match[2]); }
      } else if (/[\u4e00-\u9fff]/.test(line) && !zh) {
        zh = line;
      } else {
        enParts.push(line);
      }
    }
    const en = enParts.join(' ').trim();
    if (nameLine && en) cards.push({ name: nameLine, en, zh, url });
  }

  const topCards = cards.slice(0, 5);
  let html = '';

  for (const card of topCards) {
    html += `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px"><tr><td>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8f8fa;border:1px solid #ebebeb;border-radius:12px">
        <tr><td style="padding:16px 20px">
          <p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#1a1a1a;font-family:${font}">${card.name}</p>
          <p style="margin:0;font-size:13px;line-height:1.65;color:#374151;font-family:${font}">${card.en}</p>
          ${card.zh ? `<p style="margin:8px 0 0;font-size:12px;line-height:1.6;color:#888;font-family:${font}">${card.zh}</p>` : ''}
          ${card.url ? `<p style="margin:10px 0 0"><a href="${card.url}" style="font-size:11px;color:#6366f1;text-decoration:none;border:1px solid #e0e0ff;border-radius:14px;padding:3px 12px;font-family:${font}">View Post</a></p>` : ''}
        </td></tr>
      </table>
    </td></tr></table>`;
  }

  if (cards.length > 5) {
    html += `<p style="margin:4px 0 16px;font-size:12px;color:#aaa;text-align:center;font-family:${font}">+ ${cards.length - 5} more on the website</p>`;
  }

  if (podcastCard) {
    html += `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0"><tr><td>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#1a1a2e;border-radius:14px">
        <tr><td style="padding:22px 24px">
          <p style="margin:0 0 12px;font-size:11px;color:#888;letter-spacing:1.5px;text-transform:uppercase;font-family:${font}">PODCAST HIGHLIGHT</p>
          <p style="margin:0;font-size:15px;font-weight:600;color:#fff;line-height:1.55;font-family:${font}">${podcastCard.takeawayEn}</p>
          ${podcastCard.takeawayZh ? `<p style="margin:10px 0 0;font-size:13px;color:rgba(255,255,255,0.55);font-family:${font}">${podcastCard.takeawayZh}</p>` : ''}
        </td></tr>
      </table>
    </td></tr></table>`;
  }

  html += `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0"><tr><td align="center">
    <a href="${SITE_URL}" style="display:inline-block;background:#f5c542;color:#1a1a1a;font-size:15px;font-weight:700;text-decoration:none;padding:14px 44px;border-radius:28px;font-family:${font}">View Full Digest</a>
  </td></tr></table>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:${font}">
<center><div style="max-width:640px;margin:0 auto;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06)">
<table width="640" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;background:#fff">
  <tr><td><div style="background:#f5c542;padding:12px 24px;display:flex;align-items:center;justify-content:space-between">
    <h1 style="margin:0;color:#1a1a1a;font-size:20px;font-weight:800;font-family:${font}">AI Builders Digest</h1>
    <p style="margin:0;color:#9a8530;font-size:11px;font-family:${font}">${dateStr}</p>
  </div></td></tr>
  <tr><td style="padding:24px 24px 28px">${html}</td></tr>
  <tr><td style="padding:16px 24px;text-align:center;border-top:1px solid #f0f0f0">
    <p style="margin:0;color:#bbb;font-size:11px;font-family:${font}">Follow Builders, Not Influencers</p>
  </td></tr>
</table></div></center></body></html>`;
}

// -- Main ---------------------------------------------------------------------

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`Updating site for ${today}...`);

  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });

  const dataPath = join(DATA_DIR, `${today}.json`);
  const digestPath = join(DATA_DIR, `${today}-digest.json`);

  // Fetch feeds
  console.log('Fetching feeds...');
  const [feedX, feedPodcasts] = await Promise.all([
    fetchJSON(FEED_X_URL),
    fetchJSON(FEED_PODCASTS_URL)
  ]);

  if (!feedX && !feedPodcasts) {
    console.error('Could not fetch any feeds');
    process.exit(1);
  }

  const xBuilders = (feedX?.x || []).filter(b => !EXCLUDE_HANDLES.includes(b.handle));
  const podcasts = feedPodcasts?.podcasts || [];

  // Save raw data
  const dayData = {
    generatedAt: new Date().toISOString(),
    x: xBuilders,
    podcasts: podcasts.map(p => ({ name: p.name, title: p.title, url: p.url, publishedAt: p.publishedAt }))
  };
  await writeFile(dataPath, JSON.stringify(dayData, null, 2));
  console.log(`Saved ${dataPath}`);

  // Generate bilingual digest
  console.log('Generating translations...');
  let digest = await translateWithClaude(xBuilders, podcasts);
  if (!digest) {
    console.log('Falling back to Google Translate...');
    digest = await translateWithGoogle(xBuilders, podcasts);
  }

  await writeFile(digestPath, JSON.stringify(digest, null, 2));
  console.log(`Saved ${digestPath}`);

  // Send email
  await sendEmail(digestPath, dataPath);

  console.log('Done!');
}

main().catch(err => {
  console.error('Update failed:', err.message);
  process.exit(1);
});
