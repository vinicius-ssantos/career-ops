#!/usr/bin/env node

/**
 * extract-jd.mjs — local job description extraction via Playwright
 *
 * Usage:
 *   node extract-jd.mjs <url>
 *   node extract-jd.mjs <url> --json
 *   node extract-jd.mjs <url> --out jds/company-role.md
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';

const EXPIRED_PATTERNS = [
  /job (is )?no longer available/i,
  /job.*no longer open/i,
  /position has been filled/i,
  /this job has expired/i,
  /job posting has expired/i,
  /no longer accepting applications/i,
  /this (position|role|job) (is )?no longer/i,
  /this job (listing )?is closed/i,
  /job (listing )?not found/i,
  /page you are looking for doesn.t exist/i,
  /\d+\s+jobs?\s+found/i,
  /search for jobs page is loaded/i,
];

const APPLY_PATTERNS = [
  /\bapply\b/i,
  /\bsolicitar\b/i,
  /\bbewerben\b/i,
  /\bpostuler\b/i,
  /submit application/i,
  /easy apply/i,
  /start application/i,
];

function parseArgs(argv) {
  let url = '';
  let json = false;
  let out = '';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--out') {
      out = argv[i + 1] || '';
      i += 1;
    } else if (!url) {
      url = arg;
    }
  }

  if (!url) {
    console.error('Usage: node extract-jd.mjs <url> [--json] [--out path]');
    process.exit(1);
  }

  return { url, json, out };
}

function normalizeWhitespace(text) {
  return text
    .replace(/\r/g, '')
    .replace(/\t/g, ' ')
    .replace(/[ \u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function inferCompany(url, title) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const parts = host.split('.');
    if (host.includes('greenhouse.io') || host.includes('ashbyhq.com') || host.includes('lever.co')) {
      const segment = parsed.pathname.split('/').filter(Boolean)[0];
      if (segment) return segment.replace(/[-_]/g, ' ');
    }
    if (parts.length >= 2) return parts[parts.length - 2];
  } catch {}

  if (title.includes(' at ')) {
    return title.split(' at ').pop().trim();
  }

  return 'Unknown';
}

function buildMarkdown(result) {
  const lines = [
    `# ${result.title}`,
    '',
    `**URL:** ${result.url}`,
    `**Company:** ${result.company}`,
    `**Verification:** ${result.verification}`,
    '',
    '## Job Description',
    '',
    result.content || '_No extractable content found._',
    '',
  ];
  return lines.join('\n');
}

async function extract(url) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1600 },
  });

  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const status = response?.status() ?? 0;
    const finalUrl = page.url();
    const title = await page.title();
    const payload = await page.evaluate(() => {
      const selectors = [
        'main',
        '[role="main"]',
        'article',
        '.job-description',
        '.job-post',
        '.posting',
        '.posting-page',
        '.careers-job-description',
      ];

      let target = document.body;
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (node && node.innerText && node.innerText.trim().length > 300) {
          target = node;
          break;
        }
      }

      const anchors = Array.from(document.querySelectorAll('a, button'))
        .map((node) => node.innerText || '')
        .filter(Boolean)
        .slice(0, 50);

      return {
        text: target?.innerText || document.body?.innerText || '',
        anchors,
        h1: document.querySelector('h1')?.textContent || '',
      };
    });

    const text = normalizeWhitespace(payload.text);
    const anchorBlob = payload.anchors.join('\n');

    let verification = 'active';
    let reason = 'content extracted';

    if (status === 404 || status === 410) {
      verification = 'expired';
      reason = `HTTP ${status}`;
    } else if (EXPIRED_PATTERNS.some((pattern) => pattern.test(text))) {
      verification = 'expired';
      reason = 'expired pattern detected';
    } else if (text.length < 300) {
      verification = 'uncertain';
      reason = 'low content volume';
    } else if (!APPLY_PATTERNS.some((pattern) => pattern.test(text) || pattern.test(anchorBlob))) {
      verification = 'uncertain';
      reason = 'no apply signal detected';
    }

    const bestTitle = normalizeWhitespace(payload.h1 || title || 'Untitled role');
    const company = normalizeWhitespace(inferCompany(finalUrl, bestTitle));

    return {
      url,
      finalUrl,
      status,
      title: bestTitle,
      company,
      verification,
      reason,
      content: text,
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const { url, json, out } = parseArgs(process.argv.slice(2));
  const result = await extract(url);

  if (out) {
    const path = resolve(out);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, buildMarkdown(result), 'utf8');
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Title: ${result.title}`);
  console.log(`Company: ${result.company}`);
  console.log(`Verification: ${result.verification} (${result.reason})`);
  console.log(`Final URL: ${result.finalUrl}`);
  console.log('');
  console.log(result.content);
}

main().catch((err) => {
  console.error(`extract-jd.mjs failed: ${err.message}`);
  process.exit(1);
});
