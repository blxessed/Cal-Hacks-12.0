const menuBtn = document.getElementById('menuBtn');
const navList = document.getElementById('navList');
menuBtn.addEventListener('click', () => navList.classList.toggle('open'));

const sections = document.querySelectorAll('section');
const links = document.querySelectorAll('nav a');
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      links.forEach(l => l.classList.remove('active'));
      const id = entry.target.id;
      const active = document.querySelector(`nav a[href="#${id}"]`);
      if (active) active.classList.add('active');
    }
  });
}, { threshold: 0.6 });
sections.forEach(sec => observer.observe(sec));

const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
}, { threshold: 0.2 });
document.querySelectorAll('.reveal, .tile').forEach(el => revealObserver.observe(el));

const toTop = document.getElementById('toTop');
window.addEventListener('scroll', () => {
  if (window.scrollY > 500) toTop.classList.add('show'); else toTop.classList.remove('show');
});

const counters = document.querySelectorAll('[data-counter]');
const countObs = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const el = entry.target;
      if (el.dataset.counterAnimated === 'true') {
        countObs.unobserve(el);
        return;
      }
      const target = Number(el.dataset.counter);
      if (!Number.isFinite(target)) {
        countObs.unobserve(el);
        return;
      }
      let current = 0;
      const step = Math.max(1, Math.round(target / 60));

      const tick = () => {
        current += step;
        if (current >= target) {
          el.textContent = target;
          el.dataset.counterAnimated = 'true';
          countObs.unobserve(el);
        } else {
          el.textContent = current;
          requestAnimationFrame(tick);
        }
      };

      requestAnimationFrame(tick);
    }
  });
}, { threshold: 1 });
counters.forEach(c => countObs.observe(c));

const activeMembersEl = document.getElementById('activeMembersCount');
if (activeMembersEl) {
  const discordWidgetUrl = 'https://discord.com/api/guilds/1417669547388964866/widget.json';
  const applyMemberCount = (count) => {
    const memberCount = Math.max(0, Math.round(count));
    const countString = String(memberCount);
    activeMembersEl.dataset.counter = countString;
    activeMembersEl.setAttribute('data-counter', countString);
    if (activeMembersEl.dataset.counterAnimated === 'true') {
      activeMembersEl.textContent = memberCount;
    } else {
      activeMembersEl.textContent = memberCount;
      activeMembersEl.dataset.counterAnimated = 'true';
      try { countObs.unobserve(activeMembersEl); } catch (_) {}
    }
  };
  const setMemberCountUnavailable = () => {
    activeMembersEl.dataset.counter = 'N/A';
    activeMembersEl.setAttribute('data-counter', 'N/A');
    activeMembersEl.textContent = 'N/A';
    activeMembersEl.dataset.counterAnimated = 'true';
    try { countObs.unobserve(activeMembersEl); } catch (_) {}
  };
  const resolveMemberCount = (payload) => {
    if (Array.isArray(payload?.members)) return payload.members.length;
    const fallbackFields = [payload?.presence_count, payload?.approximate_presence_count, payload?.approximate_member_count];
    for (const value of fallbackFields) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
    }
    return NaN;
  };
  const encodedWidgetUrl = encodeURIComponent(discordWidgetUrl);
  const widgetSources = [
    discordWidgetUrl,
    `https://cors.isomorphic-git.org/${discordWidgetUrl}`,
    `https://api.allorigins.win/raw?url=${encodedWidgetUrl}`,
    `https://corsproxy.io/?${encodedWidgetUrl}`,
    `https://r.jina.ai/${discordWidgetUrl}`
  ];
  const appendBust = (url) => `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
  const fetchWidget = async (url) => {
    const res = await fetch(appendBust(url), { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  (async () => {
    for (const source of widgetSources) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const data = await fetchWidget(source);
          const resolved = resolveMemberCount(data);
          if (!Number.isFinite(resolved)) throw new Error('Invalid member count payload');
          applyMemberCount(resolved);
          return;
        } catch (err) {
          console.error('Failed to load Discord member count', err);
        }
      }
    }
    setMemberCountUnavailable();
  })();
}

const urlForm = document.getElementById('urlForm');
const urlInput = document.getElementById('urlInput');
const urlStatus = document.getElementById('urlStatus');
const clearUrlBtn = document.getElementById('clearUrl');

const autoResize = (field) => {
  if (!field) return;
  const base = Number(field.dataset.baseHeight) || field.clientHeight || 220;
  field.dataset.baseHeight = base;
  field.style.height = 'auto';
  field.dataset.growing = 'true';
  const next = Math.max(base, field.scrollHeight);
  field.style.height = `${next}px`;
  requestAnimationFrame(() => field.removeAttribute('data-growing'));
};

const attachAutoResize = (field) => {
  if (!field) return;
  autoResize(field);
  field.addEventListener('input', () => autoResize(field));
};

if (urlForm && urlInput && urlStatus) {
  const setStatus = (message, state = '') => {
    urlStatus.textContent = message;
    if (state) {
      urlStatus.dataset.state = state;
    } else {
      urlStatus.removeAttribute('data-state');
    }
  };

  attachAutoResize(urlInput);

  urlForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const raw = urlInput.value.trim();
    if (!raw) {
      setStatus('Please paste a URL to analyze.', 'error');
      urlInput.focus();
      return;
    }
    try {
      new URL(raw);
    } catch (err) {
      setStatus('That does not look like a valid URL.', 'error');
      urlInput.focus();
      return;
    }

    setStatus('URL saved. Analysis has been queued.', 'ready');
    autoResize(urlInput);
  });

  if (clearUrlBtn) {
    clearUrlBtn.addEventListener('click', () => {
      urlInput.value = '';
      setStatus('Waiting for a link…');
      autoResize(urlInput);
      urlInput.focus();
    });
  }
}

const textBox = document.getElementById('textBox');
const countsEl = document.getElementById('counts');
const saveTextBtn = document.getElementById('saveText');
const clearTextBtn = document.getElementById('clearText');

if (textBox && countsEl) {
  const storageKey = 'facttrace:text-draft';
  let resetTimer = null;

  attachAutoResize(textBox);

  const applyCounts = (value) => {
    const trimmed = value.trim();
    const words = trimmed ? trimmed.split(/\s+/).length : 0;
    const characters = value.length;
    countsEl.textContent = `${words} words • ${characters} characters`;
    if (countsEl.dataset.state) countsEl.removeAttribute('data-state');
  };

  const showTransientStatus = (message, state, duration = 2200) => {
    countsEl.textContent = message;
    countsEl.dataset.state = state;
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      applyCounts(textBox.value);
    }, duration);
  };

  let stored = '';
  try {
    stored = localStorage.getItem(storageKey) || '';
  } catch (err) {
    console.warn('Unable to access stored text draft.', err);
    stored = '';
  }
  if (stored) textBox.value = stored;
  applyCounts(textBox.value);
  autoResize(textBox);

  textBox.addEventListener('input', (event) => {
    applyCounts(event.target.value);
    autoResize(event.target);
  });

  textBox.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      try {
        localStorage.setItem(storageKey, textBox.value);
        showTransientStatus('Draft saved to browser storage.', 'ready');
      } catch (err) {
        console.warn('Unable to save draft via keyboard shortcut.', err);
        showTransientStatus('Unable to save draft in this browser.', 'error', 2600);
      }
    }
  });

  if (saveTextBtn) {
    saveTextBtn.addEventListener('click', () => {
      try {
        localStorage.setItem(storageKey, textBox.value);
        showTransientStatus('Draft saved to browser storage.', 'ready');
      } catch (err) {
        console.warn('Unable to save draft via button.', err);
        showTransientStatus('Unable to save draft in this browser.', 'error', 2600);
      }
      autoResize(textBox);
    });
  }

  if (clearTextBtn) {
    clearTextBtn.addEventListener('click', () => {
      textBox.value = '';
      try {
        localStorage.removeItem(storageKey);
      } catch (err) {
        console.warn('Unable to clear draft from storage.', err);
      }
      applyCounts('');
      autoResize(textBox);
      showTransientStatus('Workspace cleared.', 'ready', 1800);
      textBox.focus();
    });
  }
}
