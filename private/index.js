if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const axios = require('axios');

const PORT = Number(process.env.PORT) || 8787;
const EXA_SEARCH_URL = process.env.EXA_SEARCH_URL || 'https://api.exa.ai/search';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = ((process.env.GROQ_MODEL || "openai/gpt-oss-120b" ).trim());
const GROQ_TIMEOUT_MS = 20000;
const LLM_MAX_TOKENS = 600;
const ARTICLE_CHAR_LIMIT = 6000;
const MAX_REQUEST_BYTES = 128 * 1024;
const USER_AGENT = process.env.FACTTRACE_USER_AGENT || 'FactTrace/1.0 (+https://facttrace)';
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const DEFAULT_DOCUMENT = 'index.html';
const STATIC_CACHE_CONTROL = process.env.NODE_ENV === 'production' ? 'public, max-age=600' : 'no-store';
const RELIABILITY_DATASET_PATH = process.env.RELIABILITY_DATASET_PATH || path.resolve(__dirname, 'news_channels_bias_reliability.csv');
const MIN_ALLOWED_RELIABILITY = Number(process.env.MIN_RELIABILITY_SCORE) || 35;
const MAX_ALLOWED_BIAS = Number(process.env.MAX_BIAS_SCORE) || 10;

const normalizeDomainKey = (value = '') => value.replace(/^\.+/, '').trim().toLowerCase();
const normalizeNameKey = (value = '') => value.replace(/[^a-z0-9]+/gi, '').toLowerCase();

const sourceReliabilityIndex = loadSourceReliability();
const reliabilityEnforced = () => sourceReliabilityIndex.byDomain.size > 0;

const requiredEnv = ['EXA_API_KEY', 'GROQ_API_KEY'];
const missing = requiredEnv.filter((key) => !process.env[key]);
if (missing.length) {
  console.warn(`⚠️  Missing env vars: ${missing.join(', ')}. The analysis endpoint will fail until they are set.`);
}

const clampPercentage = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(100, Math.max(0, numeric));
};

const normalizePercentages = (factual, misinformation) => {
  const f = clampPercentage(factual);
  const m = clampPercentage(misinformation);
  if (f === 0 && m === 0) return { factual: 50, misinformation: 50 };
  const total = f + m;
  if (total === 0) return { factual: 50, misinformation: 50 };
  if (total === 100) return { factual: Math.round(f), misinformation: Math.round(m) };
  return {
    factual: Math.round((f / total) * 100),
    misinformation: Math.round((m / total) * 100)
  };
};

const sanitizeText = (value = '') => {
  if (!value) return '';
  return value.replace(/\s+/g, ' ').replace(/&nbsp;/gi, ' ').trim();
};

const stripHtml = (html = '') => {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ');
};

const stripQuery = (value = '') => value.split('#')[0].split('?')[0];

const fetchHtmlWithFallback = async (url) => {
  const normalized = stripQuery(url);
  const attempts = [
    { label: 'direct', target: url },
    { label: 'r.jina.ai', target: `https://r.jina.ai/${normalized}` },
    { label: 'textise dot iitty', target: `https://r.jina.ai/http://r.jina.ai/https://r.jina.ai/${normalized}` }
  ];
  const errors = [];
  for (const attempt of attempts) {
    try {
      const { data } = await axios.get(attempt.target, {
        timeout: Number(process.env.ARTICLE_FETCH_TIMEOUT) || 15000,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml'
        },
        responseType: 'text'
      });
      if (typeof data === 'string') return data;
      if (Buffer.isBuffer(data)) return data.toString('utf8');
      return String(data ?? '');
    } catch (err) {
      errors.push(err.message || err);
      continue;
    }
  }
  const lastError = errors[errors.length - 1] || 'Unable to fetch article body';
  throw new Error(lastError);
};

const collectBody = (req) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > MAX_REQUEST_BYTES) {
      reject(new Error('Payload too large'));
      req.socket.destroy();
    }
  });
  req.on('end', () => resolve(body));
  req.on('error', reject);
});

const respond = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
};

const applyCors = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
};

function loadSourceReliability() {
  try {
    const raw = fs.readFileSync(RELIABILITY_DATASET_PATH, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return { byDomain: new Map(), byName: new Map() };
    const headers = splitCsvLine(lines.shift());
    const idx = (key) => headers.indexOf(key);
    const indices = {
      domain: idx('domain'),
      moniker: idx('moniker_name'),
      biasMean: idx('bias_mean'),
      biasLabel: idx('bias_label'),
      reliabilityMean: idx('reliability_mean'),
      reliabilityLabel: idx('reliability_label')
    };
    const byDomain = new Map();
    const byName = new Map();
    for (const line of lines) {
      const cols = splitCsvLine(line);
      const domain = normalizeDomainKey(cols[indices.domain] || '');
      if (!domain) continue;
      const entry = {
        domain,
        moniker: cols[indices.moniker] || '',
        biasMean: Number(cols[indices.biasMean]),
        biasLabel: cols[indices.biasLabel] || '',
        reliabilityMean: Number(cols[indices.reliabilityMean]),
        reliabilityLabel: cols[indices.reliabilityLabel] || ''
      };
      byDomain.set(domain, entry);
      if (entry.moniker) {
        byName.set(normalizeNameKey(entry.moniker), entry);
      }
    }
    console.log(`Loaded ${byDomain.size} source reliability entries from CSV.`);
    return { byDomain, byName };
  } catch (err) {
    console.warn('Unable to load reliability dataset:', err.message || err);
    return { byDomain: new Map(), byName: new Map() };
  }
}

function splitCsvLine(line = '') {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

const findSourceByDomain = (hostname = '') => {
  if (!hostname) return null;
  let host = normalizeDomainKey(hostname);
  while (host) {
    if (sourceReliabilityIndex.byDomain.has(host)) {
      return sourceReliabilityIndex.byDomain.get(host);
    }
    const next = host.split('.').slice(1).join('.');
    if (!next || next === host) break;
    host = next;
  }
  return null;
};

const findSourceByName = (name = '') => {
  if (!name) return null;
  const key = normalizeNameKey(name);
  if (!key) return null;
  return sourceReliabilityIndex.byName.get(key) || null;
};

const evaluateSourceReliability = (payload = {}, { strict = true } = {}) => {
  if (!reliabilityEnforced()) {
    return {
      acceptable: true,
      biasMean: null,
      biasLabel: null,
      reliabilityMean: null,
      reliabilityLabel: null,
      domain: null,
      moniker: null,
      reason: null
    };
  }
  const hostname = safeHostname(payload.url);
  const domainMatch = hostname ? findSourceByDomain(hostname) : null;
  const publisherMatch = payload.publisher ? findSourceByName(payload.publisher) : null;
  const match = domainMatch || publisherMatch;
  if (!match) {
    return {
      acceptable: strict ? false : true,
      reason: 'Source not present in reliability dataset'
    };
  }
  const biasMean = Number(match.biasMean);
  const reliabilityMean = Number(match.reliabilityMean);
  const acceptable = Number.isFinite(biasMean) && Number.isFinite(reliabilityMean) &&
    Math.abs(biasMean) <= MAX_ALLOWED_BIAS &&
    reliabilityMean >= MIN_ALLOWED_RELIABILITY;
  return {
    acceptable: strict ? acceptable : true,
    biasMean,
    biasLabel: match.biasLabel,
    reliabilityMean,
    reliabilityLabel: match.reliabilityLabel,
    domain: match.domain,
    moniker: match.moniker,
    reason: acceptable ? null : 'Source did not meet reliability or bias requirements'
  };
};

const annotateReliableResults = (results = []) => {
  if (!sourceReliabilityIndex.byDomain.size) {
    console.warn('Reliability dataset is empty. Skipping source filtering.');
    return results.map((result) => ({ ...result, sourceMeta: null }));
  }
  const annotated = results.map((result) => {
    const sourceMeta = evaluateSourceReliability(result);
    return { ...result, sourceMeta };
  });
  return annotated.filter((entry) => entry.sourceMeta.acceptable);
};

const safeHostname = (urlValue = '') => {
  try {
    const parsed = new URL(urlValue);
    return parsed.hostname;
  } catch (_) {
    return null;
  }
};

const extractFirstUrl = (value = '') => {
  if (!value) return null;
  const match = value.match(/https?:\/\/[^\s]+/i);
  if (!match) return null;
  return trimTrailingPunctuation(match[0]);
};

const trimTrailingPunctuation = (value = '') => value.replace(/[),.;!?]+$/, '');

const extractHtmlTitle = (html = '') => {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (!match) return null;
  return sanitizeText(match[1]);
};

const questionToStatement = (text = '') => {
  const trimmed = sanitizeText(text);
  if (!trimmed) return '';
  if (!/[?？]$/.test(trimmed)) return trimmed;
  const withoutQ = trimmed.replace(/[?？]+$/, '').trim();
  if (!withoutQ) return trimmed;
  return `It is claimed that ${withoutQ}.`;
};

const selectArticleText = async (result) => {
  const fragments = [];
  ['text', 'content', 'summary', 'synopsis', 'description'].forEach((field) => {
    if (typeof result?.[field] === 'string') fragments.push(result[field]);
  });
  if (Array.isArray(result?.highlights)) fragments.push(result.highlights.join('\n'));

  const combined = sanitizeText(fragments.join('\n\n'));
  if (combined.length > 600) return combined;

  if (!result?.url) return combined;
  try {
    const html = await fetchHtmlWithFallback(result.url);
    const text = sanitizeText(stripHtml(html));
    return text || combined;
  } catch (err) {
    console.warn('Failed to fetch article body:', err.message || err);
    return combined;
  }
};

const fetchDirectArticle = async (url) => {
  const html = await fetchHtmlWithFallback(url);
  const title = extractHtmlTitle(html) || url;
  const text = sanitizeText(stripHtml(html));
  return { title, text };
};

const buildDirectArticlePayload = async (url) => {
  let article;
  try {
    article = await fetchDirectArticle(url);
  } catch (err) {
    const msg = err.response?.status ? `Failed to fetch article (HTTP ${err.response.status})` : err.message;
    throw new Error(msg || 'Unable to fetch the provided URL');
  }
  if (!article.text || article.text.length < 400) {
    throw new Error('Unable to extract meaningful text from the provided URL.');
  }
  const sourceMeta = evaluateSourceReliability({ url }, { strict: true });
  if (reliabilityEnforced() && !sourceMeta.acceptable) {
    throw new Error('The provided URL is not in our reliable sources list. Please choose a more balanced outlet.');
  }
  return {
    title: article.title,
    url,
    articleText: article.text,
    snippet: article.text.slice(0, 280),
    sourceMeta: reliabilityEnforced() ? sourceMeta : null
  };
};

const searchExa = async (query) => {
  if (!process.env.EXA_API_KEY) throw new Error('Missing EXA_API_KEY');
  const payload = {
    query,
    useAutoprompt: true,
    category: 'news',
    numResults: Number(process.env.EXA_RESULTS_LIMIT) || 8,
    type: process.env.EXA_SEARCH_TYPE || 'auto'
  };

  const { data } = await axios.post(EXA_SEARCH_URL, payload, {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.EXA_API_KEY
    },
    timeout: Number(process.env.EXA_TIMEOUT) || 15000
  });
  if (!data?.results || !Array.isArray(data.results)) return [];
  return data.results;
};

const analyzeWithGroq = async ({ query, articleText, articleUrl, articleTitle, sourceMeta }) => {
  if (!process.env.GROQ_API_KEY) throw new Error('Missing GROQ_API_KEY');
  const trimmedArticle = articleText.slice(0, ARTICLE_CHAR_LIMIT);
  const instructions = [
    'You are FactTrace, a meticulous misinformation analyst.',
    'Return factual and misinformation percentages that sum to roughly 100.',
    'Judge the truthfulness of the user claim itself, not whether the evidence source is reliable or balanced.',
    'If the evidence clearly debunks or contradicts the claim, mark misinformationPercentage close to 100 and factualPercentage near 0.',
    'If the evidence strongly supports the claim, mark factualPercentage near 100.',
    'Add a concise summary that references why the claim is true or false based on the evidence.',
    'Favor outlets with balanced bias (bias_mean near zero) and strong reliability (high reliability_mean), and mention any reliability concerns in the summary.',
    'Only output valid JSON.'
  ].join(' ');

  const reliabilityContext = sourceMeta ? [
    'Source reliability data (from curated CSV dataset):',
    `- Outlet: ${sourceMeta.moniker || sourceMeta.domain || 'Unknown'}`,
    `- Domain: ${sourceMeta.domain || 'Unknown'}`,
    `- Bias mean: ${typeof sourceMeta.biasMean === 'number' ? sourceMeta.biasMean.toFixed(2) : 'Unknown'} (${sourceMeta.biasLabel || 'Unlabeled'})`,
    `- Reliability mean: ${typeof sourceMeta.reliabilityMean === 'number' ? sourceMeta.reliabilityMean.toFixed(2) : 'Unknown'} (${sourceMeta.reliabilityLabel || 'Unlabeled'})`,
    'Interpret negative bias as left-leaning, positive bias as right-leaning.',
    'If reliability_label indicates unreliable/problematic coverage, highlight any issues you find.'
  ].join('\n') : 'No reliability metadata was available for this source.';

  const payload = {
    model: GROQ_MODEL,
    temperature: 0.2,
    max_tokens: LLM_MAX_TOKENS,
    messages: [
      { role: 'system', content: instructions },
      {
        role: 'user',
        content: `Claim to evaluate: ${query || 'No explicit claim provided'}\nEvidence source: ${articleTitle || 'Unknown'}\nURL: ${articleUrl || 'Unknown'}\n${reliabilityContext}\nArticle evidence:\n"""\n${trimmedArticle}\n"""\nRespond with JSON matching {"factualPercentage": number, "misinformationPercentage": number, "summary": string}`
      }
    ]
  };

  const { data } = await axios.post(GROQ_API_URL, payload, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`
    },
    timeout: GROQ_TIMEOUT_MS
  });

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('Empty response from Groq');

  const parsed = safeJson(content);
  if (!parsed) throw new Error('Unable to parse Groq response as JSON');
  const percents = normalizePercentages(parsed.factualPercentage, parsed.misinformationPercentage);
  return {
    factualPercentage: percents.factual,
    misinformationPercentage: percents.misinformation,
    summary: parsed.summary?.trim() || 'No summary provided.',
    verdict: parsed.verdict?.trim() || null,
    raw: content
  };
};

const safeJson = (value) => {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (err) {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (_) {
      return null;
    }
  }
};

const sortResultsByPreference = (results, preferredDomain) => {
  if (!preferredDomain) return results;
  return [...results].sort((a, b) => {
    const hostA = safeHostname(a.url || '') || '';
    const hostB = safeHostname(b.url || '') || '';
    const aPreferred = hostA === preferredDomain;
    const bPreferred = hostB === preferredDomain;
    if (aPreferred === bPreferred) return 0;
    return aPreferred ? -1 : 1;
  });
};

const pickArticle = async (results = [], preferredDomain = null) => {
  const ordered = sortResultsByPreference(results, preferredDomain);
  for (const result of ordered) {
    try {
      const articleText = await selectArticleText(result);
      if (articleText?.length > 400) {
        return { ...result, articleText };
      }
    } catch (err) {
      console.warn('Failed to prep article:', err.message || err);
    }
  }
  const fallback = ordered[0];
  if (!fallback) return null;
  return { ...fallback, articleText: (fallback.summary || fallback.text || '').slice(0, 800) };
};

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

const getContentType = (filePath) => mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';

const resolvePublicPath = (pathname) => {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded === '/' ? `/${DEFAULT_DOCUMENT}` : decoded;
  const resolved = path.normalize(path.join(PUBLIC_DIR, relative));
  if (!resolved.startsWith(PUBLIC_DIR)) return null;
  return resolved;
};

const streamFile = async (req, res, filePath) => {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch (err) {
    return false;
  }
  let finalPath = filePath;
  if (stat.isDirectory()) {
    finalPath = path.join(filePath, DEFAULT_DOCUMENT);
    return streamFile(req, res, finalPath);
  }

  res.writeHead(200, {
    'Content-Type': getContentType(finalPath),
    'Content-Length': stat.size,
    'Cache-Control': STATIC_CACHE_CONTROL
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  const stream = fs.createReadStream(finalPath);
  stream.on('error', (err) => {
    console.error('Static file error:', err.message || err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end('File streaming error');
  });
  stream.pipe(res);
  return true;
};

const serveStatic = async (req, res, url) => {
  if (!['GET', 'HEAD'].includes(req.method)) return false;
  if (url.pathname.startsWith('/api/')) return false;

  const filePath = resolvePublicPath(url.pathname);
  if (filePath) {
    const served = await streamFile(req, res, filePath);
    if (served) return true;
    if (path.extname(url.pathname)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Not found');
      return true;
    }
  }

  if (!path.extname(url.pathname)) {
    const fallback = path.join(PUBLIC_DIR, DEFAULT_DOCUMENT);
    const served = await streamFile(req, res, fallback);
    if (served) return true;
  }

  return false;
};

const server = http.createServer(async (req, res) => {
  applyCors(req, res);
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    respond(res, 200, { ok: true, time: new Date().toISOString() });
    return;
  }

  if (await serveStatic(req, res, url)) {
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/analyze') {
    try {
      const rawBody = await collectBody(req);
      let payload = {};
      if (rawBody) {
        try {
          payload = JSON.parse(rawBody);
        } catch (parseErr) {
          respond(res, 400, { error: 'Invalid JSON payload' });
          return;
        }
      }
      const rawQuery = String(payload.query || '');
      const directUrl = extractFirstUrl(rawQuery);
      if (directUrl) {
        respond(res, 400, { error: 'Direct URLs are not supported. Please paste the relevant text or summary from the article instead.' });
        return;
      }
      const query = sanitizeText(rawQuery);
      const normalizedClaim = questionToStatement(query || '');
      if (!normalizedClaim) {
        respond(res, 400, { error: 'Please provide a query field.' });
        return;
      }

      const searchSeed = normalizedClaim;
      const results = await searchExa(searchSeed);
      if (!results.length) {
        respond(res, 404, { error: 'No relevant articles found.' });
        return;
      }

      const reliableResults = annotateReliableResults(results);
      if (!reliableResults.length) {
        respond(res, 404, { error: 'No reliable sources matched this query. Please try refining your claim or using a different source.' });
        return;
      }

      const article = await pickArticle(reliableResults);
      if (!article?.articleText) {
        respond(res, 502, { error: 'Unable to extract article text from Exa results.' });
        return;
      }

      const analysis = await analyzeWithGroq({
        query: normalizedClaim,
        articleText: article.articleText,
        articleUrl: article.url,
        articleTitle: article.title,
        sourceMeta: article.sourceMeta || undefined
      });

      respond(res, 200, {
        query,
        normalizedClaim,
        analyzedAt: new Date().toISOString(),
        article: {
          title: article.title || 'Untitled',
          url: article.url,
          description: sanitizeText(article.summary || article.description || ''),
          publisher: article.publisher || article.source || null,
          snippet: article.articleText.slice(0, 280),
          reliability: article.sourceMeta ? {
            biasMean: article.sourceMeta.biasMean,
            biasLabel: article.sourceMeta.biasLabel,
            reliabilityMean: article.sourceMeta.reliabilityMean,
            reliabilityLabel: article.sourceMeta.reliabilityLabel,
            domain: article.sourceMeta.domain,
            moniker: article.sourceMeta.moniker
          } : null
        },
        analysis
      });
    } catch (err) {
      console.error('Analysis error:', err.response?.data || err.message || err);
      respond(res, 500, { error: err.message || 'Unexpected server error' });
    }
    return;
  }

  respond(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`FactTrace agent listening on http://localhost:${PORT}`);
});
