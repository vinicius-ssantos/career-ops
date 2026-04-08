#!/usr/bin/env node

/**
 * scan-portals.mjs — local portal scanner
 *
 * Scope:
 * - Reads tracked companies and search queries from portals.yml
 * - Supports Greenhouse APIs directly
 * - Falls back to Playwright careers page extraction for tracked companies
 * - Supports broad discovery through simple web search over search_queries
 * - Writes new URLs to data/pipeline.md and data/scan-history.tsv
 */

import { chromium } from 'playwright';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';

function parseScalar(raw) {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parsePortalsYml(content) {
  const result = {
    title_filter: { positive: [], negative: [], seniority_boost: [] },
    search_queries: [],
    tracked_companies: [],
  };

  const lines = content.split(/\r?\n/);
  let section = '';
  let subsection = '';
  let currentItem = null;

  for (const rawLine of lines) {
    const noComment = rawLine.replace(/\s+#.*$/, '');
    if (!noComment.trim()) continue;

    if (/^[A-Za-z_]+:/.test(noComment) && !noComment.startsWith(' ')) {
      section = noComment.split(':')[0].trim();
      subsection = '';
      currentItem = null;
      continue;
    }

    if (section === 'title_filter') {
      const trimmed = noComment.trim();
      if (/^[A-Za-z_]+:/.test(trimmed) && !trimmed.startsWith('-')) {
        subsection = trimmed.split(':')[0].trim();
        continue;
      }
      if (trimmed.startsWith('- ')) {
        result.title_filter[subsection] ||= [];
        result.title_filter[subsection].push(parseScalar(trimmed.slice(2)));
      }
      continue;
    }

    if (section === 'search_queries' || section === 'tracked_companies') {
      if (/^\s*-\s+name:/.test(noComment)) {
        currentItem = {
          name: parseScalar(noComment.split(/:\s+/, 2)[1] || ''),
          enabled: true,
        };
        result[section].push(currentItem);
        continue;
      }

      if (currentItem && /^\s{4}[A-Za-z_]+:/.test(noComment)) {
        const trimmed = noComment.trim();
        const [key, rest] = trimmed.split(/:\s+/, 2);
        currentItem[key] = parseScalar(rest || '');
      }
    }
  }

  return result;
}

function matchesTitleFilter(title, titleFilter) {
  const lower = title.toLowerCase();
  const positives = titleFilter.positive || [];
  const negatives = titleFilter.negative || [];

  const positiveMatch =
    positives.length === 0 ||
    positives.some((keyword) => lower.includes(String(keyword).toLowerCase()));
  const negativeKeyword = negatives.find((keyword) => lower.includes(String(keyword).toLowerCase()));

  return {
    ok: positiveMatch && !negativeKeyword,
    reason: positiveMatch ? `negative:${negativeKeyword || ''}` : 'missing_positive',
  };
}

function inferCompanyFromUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const parts = host.split('.');
    const stem = parts.length >= 2 ? parts[parts.length - 2] : host;
    return stem.replace(/[-_]/g, ' ');
  } catch {
    return 'Unknown';
  }
}

function normalizeHtml(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeDuckDuckGoHref(href) {
  try {
    if (href.startsWith('//')) {
      href = `https:${href}`;
    }
    if (href.startsWith('/')) {
      href = `https://html.duckduckgo.com${href}`;
    }

    const parsed = new URL(href);
    const uddg = parsed.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : href;
  } catch {
    return href;
  }
}

async function searchJobs(queryName, query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 career-ops scanner',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from search provider`);
  }

  const html = await response.text();
  const matches = [...html.matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];

  return matches.slice(0, 10).map((match) => {
    const href = decodeDuckDuckGoHref(match[1]);
    const title = normalizeHtml(match[2]);
    return {
      company: inferCompanyFromUrl(href),
      title,
      url: href,
      source: queryName,
    };
  }).filter((job) => job.title && job.url.startsWith('http'));
}

async function loadSeenUrls(projectRoot) {
  const seen = new Set();
  const files = [
    resolve(projectRoot, 'data', 'scan-history.tsv'),
    resolve(projectRoot, 'data', 'pipeline.md'),
    resolve(projectRoot, 'data', 'applications.md'),
  ];

  for (const file of files) {
    if (!existsSync(file)) continue;
    const text = await readFile(file, 'utf8');
    const matches = text.match(/https?:\/\/[^\s)\]|>]+/g) || [];
    for (const match of matches) seen.add(match.trim());
  }

  return seen;
}

async function fetchGreenhouseJobs(company) {
  const response = await fetch(company.api);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${company.api}`);
  }

  const payload = await response.json();
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  return jobs.map((job) => ({
    company: company.name,
    title: (job.title || '').trim(),
    url: job.absolute_url,
    source: `tracked:${company.name}:greenhouse_api`,
  })).filter((job) => job.title && job.url);
}

async function scrapeCareersPage(browser, company) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1600 },
  });

  try {
    await page.goto(company.careers_url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const jobs = await page.evaluate((companyName) => {
      const titleLike = /engineer|developer|software|backend|java|api|microservices|integration/i;
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      const items = [];

      for (const anchor of anchors) {
        const text = (anchor.innerText || anchor.textContent || '').trim().replace(/\s+/g, ' ');
        const href = anchor.href;
        if (!text || !href || text.length < 4) continue;
        if (!titleLike.test(text)) continue;
        if (/privacy|terms|cookies|benefits|linkedin|instagram|facebook/i.test(text)) continue;
        items.push({
          company: companyName,
          title: text,
          url: href,
          source: `tracked:${companyName}:careers_page`,
        });
      }

      const dedup = new Map();
      for (const item of items) {
        if (!dedup.has(item.url)) dedup.set(item.url, item);
      }
      return Array.from(dedup.values());
    }, company.name);

    return jobs;
  } finally {
    await page.close();
  }
}

async function appendPipelineEntries(projectRoot, jobs) {
  const pipelinePath = resolve(projectRoot, 'data', 'pipeline.md');
  const existing = existsSync(pipelinePath) ? await readFile(pipelinePath, 'utf8') : '# Pipeline Inbox\n\n';
  const lines = jobs.map((job) => `- [ ] ${job.url} | ${job.company} | ${job.title}`);
  const next = existing.trimEnd() + '\n' + lines.join('\n') + '\n';
  await writeFile(pipelinePath, next, 'utf8');
}

async function appendScanHistory(projectRoot, rows) {
  const historyPath = resolve(projectRoot, 'data', 'scan-history.tsv');
  const header = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n';
  const existing = existsSync(historyPath) ? await readFile(historyPath, 'utf8') : header;
  const next = existing.trimEnd() + '\n' + rows.join('\n') + '\n';
  await writeFile(historyPath, next, 'utf8');
}

async function main() {
  const projectRoot = process.cwd();
  const portalsPath = resolve(projectRoot, 'portals.yml');

  if (!existsSync(portalsPath)) {
    console.error('portals.yml not found. Copy templates/portals.example.yml first.');
    process.exit(1);
  }

  await mkdir(resolve(projectRoot, 'data'), { recursive: true });

  const portals = parsePortalsYml(await readFile(portalsPath, 'utf8'));
  const companies = (portals.tracked_companies || []).filter((company) => company.enabled !== false);
  const queries = (portals.search_queries || []).filter((query) => query.enabled !== false);
  const seen = await loadSeenUrls(projectRoot);
  let browser = null;

  let discovered = 0;
  let relevant = 0;
  let duplicates = 0;
  let added = 0;
  const newJobs = [];
  const historyRows = [];
  const skippedTitles = [];
  const errors = [];
  const today = new Date().toISOString().slice(0, 10);

  try {
    const needsBrowser = companies.some((company) => !company.api && company.careers_url);
    if (needsBrowser) {
      try {
        browser = await chromium.launch({ headless: true });
      } catch (err) {
        errors.push(`browser_launch -> ${String(err.message).replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }

    for (const company of companies) {
      let jobs = [];
      try {
        if (company.api) {
          jobs = await fetchGreenhouseJobs(company);
        } else if (company.careers_url && browser) {
          jobs = await scrapeCareersPage(browser, company);
        } else if (company.careers_url) {
          throw new Error('browser unavailable for careers page scan');
        }
      } catch (err) {
        errors.push(`tracked:${company.name} -> ${String(err.message).replace(/\s+/g, ' ')}`);
        historyRows.push([
          company.careers_url || company.api || company.name,
          today,
          `tracked:${company.name}`,
          company.name,
          company.name,
          `error:${String(err.message).replace(/\s+/g, ' ').slice(0, 80)}`,
        ].join('\t'));
        continue;
      }

      for (const job of jobs) {
        discovered += 1;
        const match = matchesTitleFilter(job.title, portals.title_filter);

        if (!match.ok) {
          skippedTitles.push(`${job.title} [${job.company}] <- ${job.source} (${match.reason})`);
          historyRows.push([job.url, today, job.source, job.title, job.company, 'skipped_title'].join('\t'));
          continue;
        }

        relevant += 1;

        if (seen.has(job.url)) {
          duplicates += 1;
          historyRows.push([job.url, today, job.source, job.title, job.company, 'skipped_dup'].join('\t'));
          continue;
        }

        seen.add(job.url);
        newJobs.push(job);
        historyRows.push([job.url, today, job.source, job.title, job.company, 'added'].join('\t'));
        added += 1;
      }
    }

    for (const query of queries) {
      let jobs = [];
      try {
        jobs = await searchJobs(query.name, query.query);
      } catch (err) {
        errors.push(`query:${query.name} -> ${String(err.message).replace(/\s+/g, ' ')}`);
        historyRows.push([
          `query:${query.name}`,
          today,
          query.name,
          query.query,
          '',
          `error:${String(err.message).replace(/\s+/g, ' ').slice(0, 80)}`,
        ].join('\t'));
        continue;
      }

      for (const job of jobs) {
        discovered += 1;
        const match = matchesTitleFilter(job.title, portals.title_filter);

        if (!match.ok) {
          skippedTitles.push(`${job.title} [${job.company}] <- ${query.name} (${match.reason})`);
          historyRows.push([job.url, today, query.name, job.title, job.company, 'skipped_title'].join('\t'));
          continue;
        }

        relevant += 1;

        if (seen.has(job.url)) {
          duplicates += 1;
          historyRows.push([job.url, today, query.name, job.title, job.company, 'skipped_dup'].join('\t'));
          continue;
        }

        seen.add(job.url);
        newJobs.push({ ...job, source: query.name });
        historyRows.push([job.url, today, query.name, job.title, job.company, 'added'].join('\t'));
        added += 1;
      }
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  if (newJobs.length > 0) {
    await appendPipelineEntries(projectRoot, newJobs);
  }
  await appendScanHistory(projectRoot, historyRows);

  console.log(`Portal Scan - ${today}`);
  console.log('------------------------------');
  console.log(`Tracked companies scanned: ${companies.length}`);
  console.log(`Search queries executed: ${queries.length}`);
  console.log(`Jobs discovered: ${discovered}`);
  console.log(`Relevant after title filter: ${relevant}`);
  console.log(`Duplicates skipped: ${duplicates}`);
  console.log(`New jobs added to pipeline: ${added}`);

  if (errors.length > 0) {
    console.log('');
    console.log('Errors:');
    for (const error of errors.slice(0, 10)) {
      console.log(`! ${error}`);
    }
  }

  if (skippedTitles.length > 0) {
    console.log('');
    console.log('Skipped by title filter:');
    for (const title of skippedTitles.slice(0, 15)) {
      console.log(`- ${title}`);
    }
  }

  if (newJobs.length > 0) {
    console.log('');
    console.log('Added to pipeline:');
    for (const job of newJobs.slice(0, 20)) {
      console.log(`+ ${job.company} | ${job.title} <- ${job.source}`);
    }
  }
}

main().catch((err) => {
  console.error(`scan-portals.mjs failed: ${err.message}`);
  process.exit(1);
});
