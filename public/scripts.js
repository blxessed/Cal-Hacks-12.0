const menuBtn = document.getElementById('menuBtn');
const navList = document.getElementById('navList');
if (menuBtn && navList) {
  menuBtn.addEventListener('click', () => navList.classList.toggle('open'));
}

const sections = document.querySelectorAll('section[id]');
const links = document.querySelectorAll('nav a');
if (sections.length && links.length) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        links.forEach(link => link.classList.remove('active'));
        const id = entry.target.id;
        const active = document.querySelector(`nav a[href="#${id}"]`);
        if (active) active.classList.add('active');
      }
    });
  }, { threshold: 0.4 });
  sections.forEach(section => observer.observe(section));
}

const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
}, { threshold: 0.2 });
document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));

const toTop = document.getElementById('toTop');
if (toTop) {
  document.addEventListener('scroll', () => {
    if (window.scrollY > 500) toTop.classList.add('show'); else toTop.classList.remove('show');
  });
}

const chartCanvas = document.getElementById('factSplit');
const factSplitMeta = document.getElementById('factSplitMeta');
const insightsEl = document.getElementById('factSplitInsights');

const RESULT_STORAGE_KEY = 'facttrace:lastResult';
const DEFAULT_RESULT = {
  misinformation: 18,
  factual: 82,
  summary: 'Corroborated reporting and primary documents align with this claim; only fringe commentary disputes it.'
};

const textBox = document.getElementById('textBox');
const countsEl = document.getElementById('counts');
const analyzeBtn = document.getElementById('analyzeText');
const analysisStatus = document.getElementById('analysisStatus');

const clearTextBtn = document.getElementById('clearText');

const state = { chart: null, analyzing: false, analyzeLabel: analyzeBtn ? analyzeBtn.textContent : 'Verify' };

const persistResult = (payload) => {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(RESULT_STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn('Unable to persist result snapshot', err);
  }
};

const determineApiBase = () => {
  if (typeof window === 'undefined') return '';
  if (window.FACTTRACE_API_BASE) return String(window.FACTTRACE_API_BASE).replace(/\/$/, '');
  const metaBase = document.querySelector('meta[name="facttrace-api"]')?.content;
  if (metaBase) return metaBase.replace(/\/$/, '');
  const origin = window.location?.origin;
  const hostname = window.location?.hostname || '';
  const port = window.location?.port || '';
  if (!origin || origin === 'null') return 'https://api.facttrace.tech';
  const localHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0']);
  if (localHosts.has(hostname) && port !== '8787') {
    return 'http://localhost:8787';
  }
  return 'https://api.facttrace.tech';
};

const apiBase = determineApiBase();
const buildUrl = (path = '') => {
  if (/^https?:\/\//i.test(path)) return path;
  if (!path.startsWith('/')) path = `/${path}`;
  return apiBase ? `${apiBase}${path}` : path;
};

const autoResize = (field) => {
  if (!field) return;
  const base = Number(field.dataset.baseHeight) || 160;
  field.style.height = 'auto';
  const next = Math.max(base, field.scrollHeight);
  field.style.height = `${next}px`;
};

const updateCounts = () => {
  if (!textBox || !countsEl) return;
  const value = textBox.value || '';
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;
  const characters = value.length;
  countsEl.textContent = `${words} ${words === 1 ? 'word' : 'words'} • ${characters} ${characters === 1 ? 'character' : 'characters'}`;
};

const setStatusMessage = (message = '', variant = '') => {
  if (!analysisStatus) return;
  analysisStatus.textContent = message;
  if (variant) analysisStatus.dataset.state = variant;
  else delete analysisStatus.dataset.state;
};

const setAnalyzing = (value) => {
  state.analyzing = value;
  if (analyzeBtn) {
    analyzeBtn.disabled = value;
    analyzeBtn.textContent = value ? 'Analyzing…' : state.analyzeLabel;
  }
};

const ensureChart = () => {
  if (state.chart || typeof Chart === 'undefined' || !chartCanvas) return state.chart;
  const colors = ['#ff3b30', '#34c759'];
  const centerTag = {
    id: 'centerTag',
    afterDraw(chart) {
      const {ctx, chartArea, data} = chart;
      if (!chartArea) return;
      const {left, right, top, bottom} = chartArea;
      const x = (left + right) / 2;
      const y = (top + bottom) / 2;
      const dataset = data.datasets[0].data;
      const maxValue = Math.max(...dataset);
      const maxIndex = dataset.indexOf(maxValue);
      const dominantColor = data.datasets[0].backgroundColor[maxIndex];
      const dominantLabel = data.labels[maxIndex];

      ctx.save();
      ctx.fillStyle = dominantColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '600 32px "SF Pro Display",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
      ctx.fillText(`${maxValue}%`, x, y - 12);
      ctx.font = '600 14px "SF Pro Text",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
      ctx.fillText(dominantLabel, x, y + 18);
      ctx.restore();
    }
  };

  state.chart = new Chart(chartCanvas, {
    type: 'doughnut',
    data: {
      labels: ['Misleading', 'Factual'],
      datasets: [{
        data: [DEFAULT_RESULT.misinformation, DEFAULT_RESULT.factual],
        backgroundColor: colors,
        borderWidth: 0,
        hoverOffset: 0
      }]
    },
    options: {
      animation: { duration: 800, easing: 'easeOutQuart' },
      cutout: '65%',
      plugins: { legend: { display: false }, tooltip: { enabled: false } }
    },
    plugins: [centerTag]
  });

  return state.chart;
};

const updateChartData = (misinformation = 50, factual = 50) => {
  const chart = ensureChart();
  if (!chart) return;
  chart.data.datasets[0].data = [misinformation, factual];
  chart.update();
};

const setMeta = (misinformation, factual, { example = false } = {}) => {
  if (!factSplitMeta) return;
  const dominant = factual >= misinformation ? 'factual' : 'misleading';
  factSplitMeta.dataset.state = dominant;
  const label = example ? 'Example result' : 'Result';
  factSplitMeta.textContent = `${label}: ${misinformation}% misleading • ${factual}% factual`;
};

const renderInsights = (summary, misinformation, factual, { example = false } = {}) => {
  if (!insightsEl) return;
  const safeSummary = summary && summary.trim()
    ? summary.trim()
    : (example ? DEFAULT_RESULT.summary : 'No summary returned.');

  insightsEl.innerHTML = `
    <li><strong>Summary:</strong> ${safeSummary}</li>
    <li><strong>Misleading:</strong> ${misinformation}% of reviewed content.</li>
    <li><strong>Factual:</strong> ${factual}% of reviewed content.</li>
  `.trim();
};

const applyResult = (misinformation, factual, summary, options = {}) => {
  const mis = Math.max(0, Math.min(100, Math.round(misinformation)));
  const fac = Math.max(0, Math.min(100, Math.round(factual)));
  updateChartData(mis, fac);
  renderInsights(summary, mis, fac, options);
};

const renderAnalysis = (payload) => {
  const factual = Number(payload?.analysis?.factualPercentage) || 0;
  const misinformation = Number(payload?.analysis?.misinformationPercentage) || 0;
  const summary = payload?.analysis?.summary || payload?.article?.description || '';

  applyResult(misinformation, factual, summary, { example: false });
};

const submitAnalysis = async (query) => {
  if (state.analyzing) return;
  setStatusMessage('Analyzing…', 'info');
  setAnalyzing(true);
  try {
    const response = await fetch(buildUrl('/api/analyze'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch (_) {
      // ignore parse error to surface generic message below
    }
    if (!response.ok || !payload) {
      const message = payload?.error || `Request failed (${response.status})`;
      throw new Error(message);
    }
    renderAnalysis(payload);
    setStatusMessage('Analysis complete ✓', 'success');
    persistResult(payload);
    window.location.href = 'results.html';
    return;
  } catch (err) {
    console.error('Analysis failed', err);
    const message = err.message || 'Unable to analyze at this time.';
    setStatusMessage(message, 'error');
  } finally {
    setAnalyzing(false);
  }
};

const analyzeClaim = () => {
  if (!textBox) return;
  const query = textBox.value.trim();
  if (!query) {
    setStatusMessage('Please enter text before analyzing.', 'error');
    textBox.focus();
    return;
  }
  if (/https?:\/\//i.test(query)) {
    setStatusMessage('Please paste the relevant text or summary instead of a direct link.', 'error');
    textBox.focus();
    return;
  }
  submitAnalysis(query);
};

if (analyzeBtn) {
  analyzeBtn.addEventListener('click', (event) => {
    event.preventDefault();
    analyzeClaim();
  });
}

if (textBox) {
  textBox.addEventListener('input', () => {
    updateCounts();
    autoResize(textBox);
  });
  textBox.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      analyzeClaim();
    }
  });
  updateCounts();
  autoResize(textBox);
}

applyResult(DEFAULT_RESULT.misinformation, DEFAULT_RESULT.factual, DEFAULT_RESULT.summary, { example: true });

if (clearTextBtn && textBox) {
  clearTextBtn.addEventListener('click', () => {
    textBox.value = '';
    updateCounts();
    autoResize(textBox);
    setStatusMessage('Workspace cleared.', 'success');
    textBox.focus();
  });
}
