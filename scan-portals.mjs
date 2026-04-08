#!/usr/bin/env node

/**
 * scan-portals.mjs - local portal scanner
 *
 * Scope:
 * - Reads tracked companies and search queries from portals.yml
 * - Prioritizes structured job boards and APIs for tracked companies
 * - Falls back to generic web search only when structured discovery finds nothing
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

const NON_JOB_TITLE_PATTERNS = [
  /monitor de ofertas/i,
  /\b\d+%\s*off\b/i,
  /\bcupom\b/i,
  /\bpromo[cç][aã]o\b/i,
  /\bfrete gr[aá]tis\b/i,
  /\bcronograma capilar\b/i,
  /\bcamisetas?\b/i,
  /\bblack friday\b/i,
  /\bguia de compras\b/i,
  /\bnot[ií]cias?\b/i,
  /\bflash\b/i,
];

const JOB_SIGNAL_PATTERNS = [
  /\bsoftware engineer\b/i,
  /\bbackend engineer\b/i,
  /\bjava developer\b/i,
  /\bdesenvolvedor(?:a)?\b/i,
  /\bengenheir(?:o|a) de software\b/i,
  /\bvaga\b/i,
  /\bopportunit(?:y|ies)\b/i,
  /\bjob\b/i,
  /\bposition\b/i,
  /\brole\b/i,
];

function passesJobSanityCheck(job) {
  const title = String(job.title || '').trim();
  const url = String(job.url || '').trim();

  if (!title || !url) {
    return { ok: false, reason: 'empty_title_or_url' };
  }

  if (NON_JOB_TITLE_PATTERNS.some((pattern) => pattern.test(title))) {
    return { ok: false, reason: 'non_job_title_pattern' };
  }

  if (/uol\.com\.br\/flash\//i.test(url)) {
    return { ok: false, reason: 'non_job_url_pattern' };
  }

  if (!JOB_SIGNAL_PATTERNS.some((pattern) => pattern.test(title))) {
    return { ok: false, reason: 'missing_job_signal' };
  }

  return { ok: true, reason: '' };
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

function safeErrorMessage(err, max = 160) {
  return String(err?.message || err || 'unknown error').replace(/\s+/g, ' ').slice(0, max);
}

function inferBoardType(careersUrl = '') {
  try {
    const parsed = new URL(careersUrl);
    const host = parsed.hostname.replace(/^www\./, '');

    if (
      host === 'boards.greenhouse.io' ||
      host === 'job-boards.greenhouse.io' ||
      host === 'job-boards.eu.greenhouse.io'
    ) {
      return 'greenhouse';
    }
    if (host === 'jobs.lever.co') return 'lever';
    if (host === 'jobs.ashbyhq.com') return 'ashby';
    if (host === 'apply.workable.com') return 'workable';
    return 'generic';
  } catch {
    return 'generic';
  }
}

function getBoardSlug(careersUrl = '') {
  try {
    const parsed = new URL(careersUrl);
    const parts = parsed.pathname.split('/').filter(Boolean);
    return parts[0] || '';
  } catch {
    return '';
  }
}

function deriveGreenhouseApiUrl(careersUrl = '') {
  const slug = getBoardSlug(careersUrl);
  return slug ? `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs` : '';
}

function deriveLeverApiUrl(careersUrl = '') {
  const slug = getBoardSlug(careersUrl);
  return slug ? `https://api.lever.co/v0/postings/${slug}?mode=json` : '';
}

function getCompanyDiscoveryMode(company) {
  if (company.api) return 'greenhouse_api';

  const boardType = inferBoardType(company.careers_url || '');
  if (boardType === 'greenhouse') return 'greenhouse_board';
  if (boardType === 'lever') return 'lever_board';
  if (boardType === 'ashby') return 'ashby_board';
  if (boardType === 'workable') return 'workable_board';
  if (company.scan_method === 'websearch' && company.scan_query) return 'websearch_fallback';
  if (company.careers_url) return 'generic_careers_page';
  return 'unsupported';
}

function uniqueByUrl(items) {
  const dedup = new Map();
  for (const item of items) {
    if (item?.url && !dedup.has(item.url)) {
      dedup.set(item.url, item);
    }
  }
  return Array.from(dedup.values());
}

function extractSearchResults(html, queryName) {
  const patterns = [
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]*href='([^']+)'[^>]*>([\s\S]*?)<\/a>/gi,
  ];

  const rawMatches = [];
  for (const pattern of patterns) {
    rawMatches.push(...html.matchAll(pattern));
  }

  return uniqueByUrl(rawMatches.map((match) => {
    const href = decodeDuckDuckGoHref(match[1] || '');
    const title = normalizeHtml(match[2] || '');
    return {
      company: inferCompanyFromUrl(href),
      title,
      url: href,
      source: `query:${queryName}`,
    };
  }).filter((job) => {
    if (!job.title || !job.url.startsWith('http')) return false;
    if (/duckduckgo\.com|google\.com\/search|bing\.com\/search/i.test(job.url)) return false;
    if (job.title.length < 8 || job.title.length > 200) return false;
    return true;
  }));
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
  return extractSearchResults(html, queryName).slice(0, 20);
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
  const apiUrl = company.api || deriveGreenhouseApiUrl(company.careers_url || '');
  if (!apiUrl) {
    throw new Error(`could not derive Greenhouse API URL for ${company.name}`);
  }

  const response = await fetch(apiUrl);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${apiUrl}`);
  }

  const payload = await response.json();
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  return jobs.map((job) => ({
    company: company.name,
    title: (job.title || '').trim(),
    url: job.absolute_url,
    source: `tracked:${company.name}:${company.api ? 'greenhouse_api' : 'greenhouse_board'}`,
  })).filter((job) => job.title && job.url);
}

async function fetchLeverJobs(company) {
  const apiUrl = deriveLeverApiUrl(company.careers_url || '');
  if (!apiUrl) {
    throw new Error(`could not derive Lever API URL for ${company.name}`);
  }

  const response = await fetch(apiUrl, {
    headers: {
      'user-agent': 'Mozilla/5.0 career-ops scanner',
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${apiUrl}`);
  }

  const payload = await response.json();
  const jobs = Array.isArray(payload) ? payload : [];
  return jobs.map((job) => ({
    company: company.name,
    title: (job.text || job.title || '').trim(),
    url: job.hostedUrl || job.applyUrl || job.urls?.show || job.urls?.apply || '',
    source: `tracked:${company.name}:lever_board`,
  })).filter((job) => job.title && job.url);
}

async function scrapeCareersPage(browser, company, sourceKind = 'careers_page') {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1600 },
  });

  try {
    await page.goto(company.careers_url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const jobs = await page.evaluate(({ companyName, sourceKind }) => {
      const titleLike = /engineer|developer|software|backend|frontend|full.?stack|java|python|data|product|architect|manager|analyst|scientist|devops|sre|qa|ai|ml|platform|support|consultant|specialist|vaga|position|role|job|opportunity/i;
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      const items = [];

      for (const anchor of anchors) {
        const text = (anchor.innerText || anchor.textContent || '').trim().replace(/\s+/g, ' ');
        const href = anchor.href;
        if (!text || !href || text.length < 4 || text.length > 180) continue;
        if (!titleLike.test(text)) continue;
        if (/privacy|terms|cookies|benefits|linkedin|instagram|facebook|twitter|about|blog|press|faq|help|login|sign in|home/i.test(text)) continue;
        if (/^(mailto:|javascript:|#)/i.test(href)) continue;
        items.push({
          company: companyName,
          title: text,
          url: href,
          source: `tracked:${companyName}:${sourceKind}`,
        });
      }

      const dedup = new Map();
      for (const item of items) {
        if (!dedup.has(item.url)) dedup.set(item.url, item);
      }
      return Array.from(dedup.values());
    }, { companyName: company.name, sourceKind });

    return jobs;
  } finally {
    await page.close();
  }
}

function shouldRunFallbackSearch(structuredCompanies, structuredDiscovered) {
  return structuredCompanies.length === 0 || structuredDiscovered === 0;
}

function buildFallbackQueries(companies, queries) {
  const companyQueries = companies
    .filter((company) => company.scan_method === 'websearch' && company.scan_query)
    .map((company) => ({
      name: `tracked:${company.name}:websearch`,
      query: company.scan_query,
    }));

  const genericQueries = queries.map((query) => ({
    name: query.name,
    query: query.query,
  }));

  return [...companyQueries, ...genericQueries];
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
  const structuredCompanies = companies.filter((company) => {
    const mode = getCompanyDiscoveryMode(company);
    return mode !== 'websearch_fallback' && mode !== 'unsupported';
  });
  const seen = await loadSeenUrls(projectRoot);
  let browser = null;

  let discovered = 0;
  let structuredDiscovered = 0;
  let fallbackDiscovered = 0;
  let relevant = 0;
  let duplicates = 0;
  let added = 0;
  let fallbackQueriesExecuted = 0;

  const newJobs = [];
  const historyRows = [];
  const skippedTitles = [];
  const errors = [];
  const addedBySource = new Map();
  const today = new Date().toISOString().slice(0, 10);

  function bumpSource(source) {
    addedBySource.set(source, (addedBySource.get(source) || 0) + 1);
  }

  function ingestJob(job, portalLabel) {
    const sanity = passesJobSanityCheck(job);
    if (!sanity.ok) {
      skippedTitles.push(`${job.title} [${job.company}] <- ${portalLabel} (${sanity.reason})`);
      historyRows.push([job.url, today, portalLabel, job.title, job.company, 'skipped_non_job'].join('\t'));
      return;
    }

    const match = matchesTitleFilter(job.title, portals.title_filter);
    if (!match.ok) {
      skippedTitles.push(`${job.title} [${job.company}] <- ${portalLabel} (${match.reason})`);
      historyRows.push([job.url, today, portalLabel, job.title, job.company, 'skipped_title'].join('\t'));
      return;
    }

    relevant += 1;
    if (seen.has(job.url)) {
      duplicates += 1;
      historyRows.push([job.url, today, portalLabel, job.title, job.company, 'skipped_dup'].join('\t'));
      return;
    }

    seen.add(job.url);
    newJobs.push(job);
    historyRows.push([job.url, today, portalLabel, job.title, job.company, 'added'].join('\t'));
    bumpSource(portalLabel);
    added += 1;
  }

  try {
    const needsBrowser = structuredCompanies.some((company) => {
      const mode = getCompanyDiscoveryMode(company);
      return mode === 'ashby_board' || mode === 'workable_board' || mode === 'generic_careers_page';
    });

    if (needsBrowser) {
      try {
        browser = await chromium.launch({ headless: true });
      } catch (err) {
        errors.push(`browser_launch -> ${safeErrorMessage(err)}`);
      }
    }

    for (const company of structuredCompanies) {
      let jobs = [];
      const mode = getCompanyDiscoveryMode(company);
      const portalLabel = `tracked:${company.name}:${mode}`;

      try {
        if (mode === 'greenhouse_api' || mode === 'greenhouse_board') {
          jobs = await fetchGreenhouseJobs(company);
        } else if (mode === 'lever_board') {
          jobs = await fetchLeverJobs(company);
        } else if ((mode === 'ashby_board' || mode === 'workable_board' || mode === 'generic_careers_page') && browser) {
          const sourceKind = mode === 'generic_careers_page' ? 'careers_page' : mode;
          jobs = await scrapeCareersPage(browser, company, sourceKind);
        } else if (mode === 'ashby_board' || mode === 'workable_board' || mode === 'generic_careers_page') {
          throw new Error('browser unavailable for careers page scan');
        } else {
          throw new Error(`unsupported discovery mode: ${mode}`);
        }
      } catch (err) {
        errors.push(`${portalLabel} -> ${safeErrorMessage(err)}`);
        historyRows.push([
          company.careers_url || company.api || company.name,
          today,
          portalLabel,
          company.name,
          company.name,
          `error:${safeErrorMessage(err, 80)}`,
        ].join('\t'));
        continue;
      }

      for (const job of jobs) {
        discovered += 1;
        structuredDiscovered += 1;
        ingestJob(job, job.source || portalLabel);
      }
    }

    if (shouldRunFallbackSearch(structuredCompanies, structuredDiscovered)) {
      const fallbackQueries = buildFallbackQueries(companies, queries);
      fallbackQueriesExecuted = fallbackQueries.length;

      for (const query of fallbackQueries) {
        let jobs = [];
        const portalLabel = `query:${query.name}`;

        try {
          jobs = await searchJobs(query.name, query.query);
        } catch (err) {
          errors.push(`${portalLabel} -> ${safeErrorMessage(err)}`);
          historyRows.push([
            portalLabel,
            today,
            portalLabel,
            query.query,
            '',
            `error:${safeErrorMessage(err, 80)}`,
          ].join('\t'));
          continue;
        }

        for (const job of jobs) {
          discovered += 1;
          fallbackDiscovered += 1;
          ingestJob(job, portalLabel);
        }
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
  console.log(`Tracked companies scanned: ${structuredCompanies.length}`);
  console.log(`Structured jobs discovered: ${structuredDiscovered}`);
  console.log(`Fallback queries executed: ${fallbackQueriesExecuted}`);
  console.log(`Fallback jobs discovered: ${fallbackDiscovered}`);
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
    console.log('Skipped by filter:');
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

  if (addedBySource.size > 0) {
    console.log('');
    console.log('Added by source:');
    for (const [source, count] of Array.from(addedBySource.entries()).sort((a, b) => b[1] - a[1])) {
      console.log(`- ${source}: ${count}`);
    }
  }
}

main().catch((err) => {
  console.error(`scan-portals.mjs failed: ${safeErrorMessage(err)}`);
  process.exit(1);
});
