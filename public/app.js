/* ==========================================================================
   DeepSeek 搜索 — 前端逻辑（无框架）
   ========================================================================== */

const SEARCH_COUNT = 30;
const MAX_QUERY_CHARS = 128;
const HISTORY_KEY = 'dss.history.v1';
const THEME_KEY = 'dss.theme';
const PER_PAGE_OPTIONS = [10, 20, 30];
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const landingView = $('#landingView');
const resultsView = $('#resultsView');
const landingForm = $('#landingForm');
const resultsForm = $('#resultsForm');
const landingInput = $('#landingInput');
const resultsInput = $('#resultsInput');
const resultsClear = $('#resultsClear');
const resultsContent = $('#resultsContent');
const statsEl = $('#stats');
const paginationEl = $('#pagination');
const filterToggle = $('#filterToggle');
const filterPanel = $('#filterPanel');
const filterForm = $('#filterForm');
const filterSite = $('#filterSite');
const filterLang = $('#filterLang');
const filterAfter = $('#filterAfter');
const filterExclude = $('#filterExclude');
const filterCountEl = $('#filterCount');
const filterChips = $('#filterChips');
const perPageSelect = $('#perPageSelect');
const keyBanner = $('#keyBanner');
const keyDot = $('#keyDot');
const demoChip = $('#demoChip');
const landingStatusDot = $('#landingStatusDot');
const apiStateText = $('#apiStateText');
const settingsDialog = $('#settingsDialog');
const keyForm = $('#keyForm');
const keyInput = $('#keyInput');
const keyStatus = $('#keyStatus');
const keyStatusText = $('#keyStatusText');
const clearKeyBtn = $('#clearKeyBtn');
const toggleKeyBtn = $('#toggleKeyBtn');
const previewOverlay = $('#previewOverlay');
const previewDrawer = $('#previewDrawer');
const previewBody = $('#previewBody');
const previewTitle = $('#previewTitle');
const previewSite = $('#previewSite');
const previewMeta = $('#previewMeta');
const previewOpen = $('#previewOpen');
const toastEl = $('#toast');

const emptyFilters = () => ({ site: '', lang: '', after: '', exclude: '' });

const state = {
  view: 'landing',
  query: '',
  filters: emptyFilters(),
  page: 1,
  perPage: 10,
  results: [],
  tookMs: 0,
  demo: false,
  loading: false,
  error: null,
};

let config = {
  hasKey: false,
  keySource: 'none',
  keyHint: '',
  demo: false,
  offline: false,
};

let searchToken = 0;
let searchController = null;
let previewController = null;
let lastPreviewTrigger = null;
let toastTimer = null;

/* ==========================================================================
   初始化
   ========================================================================== */

bindEvents();
renderHistory();
updateThemeButtons();

init();

async function init() {
  await loadConfig();
  readStateFromUrl();

  if (state.query) {
    showView('results');
    await runSearch({ pushUrl: false, recordHistory: false, scroll: false });
  } else {
    showView('landing');
  }
}

async function loadConfig() {
  try {
    const response = await fetch('/api/config', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('config request failed');
    config = await response.json();
  } catch {
    config = { hasKey: false, keySource: 'none', keyHint: '', demo: false, offline: true };
    showToast('无法连接本地服务，请确认 node server.mjs 正在运行。', 'error');
  }
  renderConfig();
}

/* ==========================================================================
   搜索流程
   ========================================================================== */

function submitSearch(rawQuery) {
  const query = String(rawQuery || '').trim();
  if (!query) {
    showToast('请输入搜索关键词。');
    activeInput().focus();
    return;
  }
  if ([...query].length > MAX_QUERY_CHARS) {
    showToast(`关键词不能超过 ${MAX_QUERY_CHARS} 个字符。`, 'error');
    return;
  }

  if (state.view === 'landing') state.filters = emptyFilters();
  state.query = query;
  state.page = 1;
  showView('results');
  syncInputs(query);
  runSearch({ pushUrl: true, recordHistory: true, scroll: true });
}

async function runSearch({ pushUrl = true, recordHistory = true, scroll = true } = {}) {
  const query = state.query.trim();
  if (!query) return;

  showView('results');
  state.loading = true;
  state.error = null;
  state.results = [];
  state.tookMs = 0;
  state.demo = false;
  closeFilterPanel(false);

  const fullQuery = buildQuery();
  const charCount = [...fullQuery].length;

  if (pushUrl) writeUrl({ push: true });
  else writeUrl({ push: false });

  searchController?.abort();
  searchController = null;
  const token = ++searchToken;

  if (charCount > MAX_QUERY_CHARS) {
    state.loading = false;
    state.error = {
      status: 400,
      message: `关键词与筛选条件组合后共 ${charCount} 个字符，超过 Search API 的 ${MAX_QUERY_CHARS} 字符限制。`,
      detail: fullQuery,
    };
    render();
    return;
  }

  searchController = new AbortController();
  const controller = searchController;

  render();

  try {
    const response = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        query: fullQuery,
        count: SEARCH_COUNT,
        ori_question: query,
      }),
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));
    if (token !== searchToken) return;

    if (!response.ok) {
      throw {
        status: response.status,
        message: data?.error?.message || '搜索请求失败。',
        detail: data?.error?.detail || '',
      };
    }

    state.results = Array.isArray(data.results) ? data.results : [];
    state.tookMs = Number(data.tookMs) || 0;
    state.demo = Boolean(data.demo);
    state.loading = false;
    state.error = null;

    if (recordHistory) addHistory();
    render();

    if (scroll) {
      window.scrollTo({ top: 0, behavior: REDUCED_MOTION ? 'auto' : 'smooth' });
    }
  } catch (error) {
    if (token !== searchToken || controller.signal.aborted) return;
    state.loading = false;
    state.results = [];
    state.tookMs = 0;
    state.error =
      error && typeof error === 'object' && error.message
        ? {
            status: Number(error.status) || 0,
            message: error.message,
            detail: error.detail || '',
          }
        : {
            status: 0,
            message: '无法连接本地搜索服务，请确认 node server.mjs 正在运行。',
            detail: '',
          };
    render();
  } finally {
    if (token === searchToken) searchController = null;
  }
}

function buildQuery() {
  const parts = [state.query.trim()];
  const { site, lang, after, exclude } = state.filters;

  if (site) parts.push(`site:${site}`);
  if (lang) parts.push(`lang:${lang}`);
  if (after) parts.push(`after:${afterDate(after)}`);

  if (exclude) {
    const tokens = exclude
      .split(/[\s,，]+/)
      .map((token) => token.trim().replace(/^-+/, '').replace(/^["“]|["”]$/g, ''))
      .filter(Boolean)
      .slice(0, 8);
    for (const token of tokens) {
      parts.push(/\s/.test(token) ? `-"${token}"` : `-${token}`);
    }
  }

  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function afterDate(preset) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  if (preset === 'week') date.setDate(date.getDate() - 7);
  else if (preset === 'month') date.setMonth(date.getMonth() - 1);
  else if (preset === 'year') date.setFullYear(date.getFullYear() - 1);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/* ==========================================================================
   URL 与视图
   ========================================================================== */

function readStateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  state.query = (params.get('q') || '').trim().slice(0, MAX_QUERY_CHARS);
  state.filters = {
    site: normalizeSite(params.get('site') || ''),
    lang: ['zh', 'en'].includes(params.get('lang')) ? params.get('lang') : '',
    after: ['week', 'month', 'year'].includes(params.get('after')) ? params.get('after') : '',
    exclude: (params.get('exclude') || '').trim().slice(0, 80),
  };
  const perPage = Number(params.get('per'));
  state.perPage = PER_PAGE_OPTIONS.includes(perPage) ? perPage : 10;
  const page = Number(params.get('page'));
  state.page = Number.isInteger(page) && page > 0 ? Math.min(page, 100) : 1;
}

function writeUrl({ push = false } = {}) {
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  if (state.filters.site) params.set('site', state.filters.site);
  if (state.filters.lang) params.set('lang', state.filters.lang);
  if (state.filters.after) params.set('after', state.filters.after);
  if (state.filters.exclude) params.set('exclude', state.filters.exclude);
  if (state.page > 1) params.set('page', String(state.page));
  if (state.perPage !== 10) params.set('per', String(state.perPage));

  const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}`;
  if (push) window.history.pushState({}, '', next);
  else window.history.replaceState({}, '', next);
}

function showView(view) {
  state.view = view;
  landingView.hidden = view !== 'landing';
  resultsView.hidden = view !== 'results';
  document.title = view === 'results' ? `${state.query} - DeepSeek 搜索` : 'DeepSeek 搜索';

  if (view === 'results') {
    syncInputs(state.query);
    updateClearButtons();
  } else {
    renderHistory();
  }
}

/* ==========================================================================
   渲染主流程
   ========================================================================== */

function render() {
  renderConfig();
  updateClearButtons();
  if (state.view !== 'results') return;

  syncInputs(state.query);
  updateTabs();
  updateFilterButton();
  renderFilterChips();
  renderAside();

  perPageSelect.value = String(state.perPage);
  resultsContent.setAttribute('aria-busy', state.loading ? 'true' : 'false');

  if (state.loading) {
    renderLoading();
    return;
  }

  if (state.error) {
    renderError();
    paginationEl.hidden = true;
    return;
  }

  if (!state.results.length) {
    renderEmpty();
    paginationEl.hidden = true;
    renderStats();
    return;
  }

  const totalPages = Math.max(1, Math.ceil(state.results.length / state.perPage));
  if (state.page > totalPages) state.page = totalPages;

  renderStats();
  renderCards();
  renderPagination();
}

function renderLoading() {
  statsEl.innerHTML = `正在搜索 <strong>“${escapeHtml(state.query)}”</strong>…`;
  resultsContent.innerHTML = Array.from(
    { length: 4 },
    () => `
      <div class="skeleton-card" aria-hidden="true">
        <div class="sk sk-meta"></div>
        <div class="sk sk-title"></div>
        <div class="sk sk-line"></div>
        <div class="sk sk-line"></div>
        <div class="sk sk-line short"></div>
        <div class="sk sk-foot"></div>
      </div>`,
  ).join('');
  paginationEl.hidden = true;
}

function renderStats() {
  const count = state.results.length;
  const demo = state.demo
    ? '<span class="demo-badge" title="演示数据，不是实时网页结果">演示数据</span>'
    : '';
  statsEl.innerHTML = `<strong>${count}</strong> 条结果<span class="stat-sep"></span>${formatDuration(
    state.tookMs,
  )}${demo}`;
}

function renderCards() {
  const start = (state.page - 1) * state.perPage;
  const items = state.results.slice(start, start + state.perPage);
  const fragment = document.createDocumentFragment();

  for (const result of items) {
    fragment.append(createResultCard(result));
  }

  resultsContent.replaceChildren(fragment);
}

function createResultCard(result) {
  const article = document.createElement('article');
  article.className = 'result-card';

  const host = hostnameOf(result.url);
  const site = result.site_name || host;

  const meta = document.createElement('div');
  meta.className = 'result-meta';

  const favicon = document.createElement('span');
  favicon.className = 'favicon';
  const letter = document.createElement('span');
  letter.className = 'favicon-letter';
  letter.textContent = (site || '?').trim().charAt(0).toUpperCase() || '?';
  favicon.append(letter);
  if (result.site_icon) {
    const image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('load', () => letter.remove(), { once: true });
    image.addEventListener('error', () => image.remove(), { once: true });
    image.src = result.site_icon;
    favicon.append(image);
  }

  const siteName = document.createElement('span');
  siteName.className = 'site-name';
  siteName.textContent = site;
  siteName.title = site;

  const crumb = document.createElement('span');
  crumb.className = 'crumb';
  crumb.textContent = formatBreadcrumb(result.url);
  crumb.title = result.url;

  meta.append(favicon, siteName, crumb);

  if (result.date) {
    const date = document.createElement('time');
    date.className = 'result-date';
    date.dateTime = result.date;
    date.textContent = formatDate(result.date);
    meta.append(date);
  }

  const title = document.createElement('h2');
  title.className = 'result-title';
  const anchor = document.createElement('a');
  anchor.href = result.url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.title = result.title;
  appendHighlighted(anchor, result.title, state.query);
  title.append(anchor);

  const snippet = document.createElement('p');
  snippet.className = 'result-snippet';
  appendHighlighted(snippet, result.snippet || '该结果暂无摘要，可打开原文查看。', state.query);

  const footer = document.createElement('div');
  footer.className = 'result-footer';

  const badges = document.createElement('div');
  badges.className = 'badges';
  if (Number(result.rerank_score) >= 1.5) {
    const badge = document.createElement('span');
    badge.className = 'badge badge-relevant';
    badge.textContent = '高相关';
    badge.title = `相关度 ${Number(result.rerank_score).toFixed(1)} / 3`;
    badges.append(badge);
  }
  if (Number(result.authority) >= 3) {
    const badge = document.createElement('span');
    badge.className = 'badge badge-authority';
    badge.textContent = '权威来源';
    badge.title = `权威度 ${result.authority} / 4`;
    badges.append(badge);
  }

  const actions = document.createElement('div');
  actions.className = 'result-actions';

  const fetchButton = document.createElement('button');
  fetchButton.type = 'button';
  fetchButton.className = 'result-action';
  fetchButton.dataset.action = 'fetch';
  fetchButton.dataset.url = result.url;
  fetchButton.title = '通过 Fetch API 抓取正文';
  fetchButton.append(createIcon('i-book'), document.createTextNode('正文预览'));

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'result-action';
  copyButton.dataset.action = 'copy';
  copyButton.dataset.url = result.url;
  copyButton.title = '复制链接';
  copyButton.append(createIcon('i-copy'), document.createTextNode('复制'));

  actions.append(fetchButton, copyButton);
  footer.append(badges, actions);

  article.append(meta, title, snippet, footer);
  return article;
}

function renderEmpty() {
  const hasFilters = activeFilterCount() > 0;
  resultsContent.innerHTML = `
    <div class="state">
      <div class="state-icon">${iconMarkup('i-search')}</div>
      <h2>没有找到相关结果</h2>
      <p>没有网页匹配 <strong>“${escapeHtml(state.query)}”</strong>${
        hasFilters ? '，并且当前筛选条件可能过严' : ''
      }。</p>
      <ul class="state-suggestions">
        <li>尝试缩短关键词，或换一种说法</li>
        <li>检查 <code>site:</code>、<code>after:</code> 等限定是否过于严格</li>
        <li>如果使用了排除词，试着去掉一两个</li>
      </ul>
      <div class="state-actions">
        ${
          hasFilters
            ? '<button class="ghost-btn" type="button" data-action="clear-filters">清除全部筛选</button>'
            : ''
        }
        <button class="primary-btn" type="button" data-action="focus-search">换个关键词</button>
      </div>
    </div>`;
}

function renderError() {
  const status = Number(state.error.status) || 0;
  const title = errorTitle(status);
  statsEl.innerHTML = `<strong>搜索失败</strong><span class="stat-sep"></span>${escapeHtml(
    status ? `HTTP ${status}` : '网络错误',
  )}`;
  const detail = state.error.detail
    ? `<div class="error-detail">${escapeHtml(state.error.detail)}</div>`
    : '';
  const is401 = status === 401;

  resultsContent.innerHTML = `
    <div class="state">
      <div class="state-icon error">${iconMarkup('i-alert')}</div>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(state.error.message || '搜索没有完成，请稍后重试。')}</p>
      ${detail}
      <div class="state-actions">
        <button class="primary-btn" type="button" data-action="retry">
          ${iconMarkup('i-refresh')}重试
        </button>
        ${
          is401
            ? `<button class="ghost-btn" type="button" data-action="settings">${iconMarkup(
                'i-key',
              )}配置 API Key</button>`
            : ''
        }
        ${
          activeFilterCount() > 0
            ? '<button class="ghost-btn" type="button" data-action="clear-filters">清除筛选</button>'
            : ''
        }
      </div>
    </div>`;
}

function errorTitle(status) {
  if (status === 401) return '需要配置 API Key';
  if (status === 402) return '账户余额不足';
  if (status === 429) return '请求太频繁';
  if (status === 502 || status === 504) return '连接 DeepSeek 失败';
  if (status === 400) return '查询条件不合法';
  return '搜索没有完成';
}

function renderPagination() {
  const totalPages = Math.ceil(state.results.length / state.perPage);
  if (totalPages <= 1) {
    paginationEl.hidden = true;
    paginationEl.replaceChildren();
    return;
  }

  const fragment = document.createDocumentFragment();

  const previous = document.createElement('button');
  previous.type = 'button';
  previous.className = 'page-btn';
  previous.dataset.page = String(state.page - 1);
  previous.disabled = state.page <= 1;
  previous.setAttribute('aria-label', '上一页');
  previous.append(createIcon('i-chevron-left'));
  fragment.append(previous);

  for (let page = 1; page <= totalPages; page += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `page-btn${page === state.page ? ' is-active' : ''}`;
    button.dataset.page = String(page);
    button.textContent = String(page);
    if (page === state.page) button.setAttribute('aria-current', 'page');
    fragment.append(button);
  }

  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'page-btn';
  next.dataset.page = String(state.page + 1);
  next.disabled = state.page >= totalPages;
  next.setAttribute('aria-label', '下一页');
  next.append(createIcon('i-chevron-right'));
  fragment.append(next);

  paginationEl.replaceChildren(fragment);
  paginationEl.hidden = false;
}

function renderAside() {
  const queryEl = $('#factQuery');
  const countEl = $('#factCount');
  const timeEl = $('#factTime');

  queryEl.textContent = state.query || '—';
  queryEl.title = state.query || '';

  if (state.loading) {
    countEl.textContent = '搜索中…';
    timeEl.textContent = '—';
  } else if (state.error) {
    countEl.textContent = '—';
    timeEl.textContent = '—';
  } else {
    countEl.textContent = `${state.results.length} 条`;
    timeEl.textContent = state.results.length ? formatDuration(state.tookMs) : '—';
  }

  const apiState = $('#apiState');
  const dot = $('.status-dot', apiState);
  const ok = config.hasKey || config.demo;
  dot.classList.toggle('is-off', !ok);

  if (config.offline) apiStateText.textContent = '本地服务未连接';
  else if (config.demo) apiStateText.textContent = '演示模式 · 不调用真实 API';
  else if (config.hasKey) apiStateText.textContent = 'API Key 已配置';
  else apiStateText.textContent = '未配置 API Key';
}

function updateTabs() {
  let active = 'all';
  if (state.filters.lang === 'zh') active = 'zh';
  else if (state.filters.lang === 'en') active = 'en';
  else if (state.filters.after === 'year') active = 'recent';

  $$('.tab').forEach((tab) => {
    const isActive = tab.dataset.tab === active;
    tab.classList.toggle('is-active', isActive);
    if (isActive) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
}

function updateFilterButton() {
  const count = activeFilterCount();
  filterCountEl.hidden = count === 0;
  filterCountEl.textContent = String(count);
}

function renderFilterChips() {
  const chips = [];

  if (state.filters.site) {
    chips.push({ key: 'site', label: `站点：${state.filters.site}` });
  }
  if (state.filters.lang) {
    chips.push({
      key: 'lang',
      label: `语言：${state.filters.lang === 'zh' ? '中文' : '英文'}`,
    });
  }
  if (state.filters.after) {
    const labels = { week: '最近一周', month: '最近一月', year: '最近一年' };
    chips.push({ key: 'after', label: `时间：${labels[state.filters.after] || state.filters.after}` });
  }
  if (state.filters.exclude) {
    chips.push({ key: 'exclude', label: `排除：${state.filters.exclude}` });
  }

  if (!chips.length) {
    filterChips.hidden = true;
    filterChips.replaceChildren();
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const chip of chips) {
    const el = document.createElement('span');
    el.className = 'filter-chip';

    const text = document.createElement('span');
    text.textContent = chip.label;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.dataset.clear = chip.key;
    remove.setAttribute('aria-label', `移除筛选：${chip.label}`);
    remove.append(createIcon('i-close'));

    el.append(text, remove);
    fragment.append(el);
  }

  if (chips.length > 1) {
    const clearAll = document.createElement('button');
    clearAll.type = 'button';
    clearAll.className = 'filter-chip';
    clearAll.dataset.clear = 'all';
    clearAll.textContent = '清除全部';
    fragment.append(clearAll);
  }

  filterChips.replaceChildren(fragment);
  filterChips.hidden = false;
}

/* ==========================================================================
   配置与 Key
   ========================================================================== */

function renderConfig() {
  const ok = Boolean(config.hasKey || config.demo);

  keyDot.classList.toggle('is-ok', ok);
  landingStatusDot.classList.toggle('is-off', !ok);
  demoChip.hidden = !config.demo;
  keyBanner.hidden = ok || Boolean(config.offline);

  const apiDot = $('#apiState .status-dot');
  if (apiDot) apiDot.classList.toggle('is-off', !ok);

  if (config.offline) {
    apiStateText.textContent = '本地服务未连接';
  } else if (config.demo) {
    apiStateText.textContent = '演示模式 · 不调用真实 API';
  } else if (config.hasKey) {
    apiStateText.textContent = 'API Key 已配置';
  } else {
    apiStateText.textContent = '未配置 API Key';
  }

  keyStatus.classList.remove('is-ok', 'is-warn');

  if (config.offline) {
    keyStatus.classList.add('is-warn');
    keyStatusText.textContent = '无法连接本地服务，请确认 node server.mjs 正在运行。';
  } else if (config.demo) {
    keyStatus.classList.add('is-warn');
    keyStatusText.textContent = '当前是演示模式，不会调用真实 API；配置 Key 后需重启并关闭 DEMO_MODE。';
  } else if (config.keySource === 'env') {
    keyStatus.classList.add('is-ok');
    keyStatusText.textContent = `正在使用环境变量中的 Key（尾号 …${config.keyHint || '????'}），保存新 Key 可在当前进程内覆盖。`;
  } else if (config.keySource === 'runtime') {
    keyStatus.classList.add('is-ok');
    keyStatusText.textContent = `已配置临时 Key（尾号 …${config.keyHint || '????'}），重启服务后失效。`;
  } else {
    keyStatus.classList.add('is-warn');
    keyStatusText.textContent = '尚未配置 API Key。';
  }

  clearKeyBtn.hidden = config.keySource !== 'runtime';
  keyInput.placeholder =
    config.hasKey && !config.demo ? '已配置，输入新 Key 可覆盖' : 'sk-…';
}

async function saveKey(event) {
  event.preventDefault();
  const key = keyInput.value.trim();
  if (!key) {
    showToast('请先输入 API Key。');
    keyInput.focus();
    return;
  }

  const saveButton = $('#keyForm button[type="submit"]');
  const originalText = saveButton.textContent;
  saveButton.disabled = true;
  saveButton.textContent = '保存中…';

  try {
    const response = await fetch('/api/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ key }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error?.message || '保存 API Key 失败。');
    }

    config = data;
    keyInput.value = '';
    keyInput.type = 'password';
    toggleKeyBtn.textContent = '显示';
    renderConfig();
    settingsDialog.close();
    showToast('API Key 已保存到当前服务进程。', 'success');

    if (state.error?.status === 401 && state.query) {
      runSearch({ pushUrl: false, recordHistory: false });
    }
  } catch (error) {
    showToast(error.message || '保存 API Key 失败。', 'error');
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = originalText;
  }
}

async function clearRuntimeKey() {
  try {
    const response = await fetch('/api/key', {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || '清除 API Key 失败。');
    config = data;
    renderConfig();
    showToast('临时 API Key 已清除。', 'success');
  } catch (error) {
    showToast(error.message || '清除 API Key 失败。', 'error');
  }
}

function openSettings() {
  if (settingsDialog.open) return;
  renderConfig();
  keyInput.value = '';
  keyInput.type = 'password';
  toggleKeyBtn.textContent = '显示';
  if (typeof settingsDialog.showModal === 'function') {
    settingsDialog.showModal();
  } else {
    settingsDialog.setAttribute('open', '');
  }
  window.setTimeout(() => keyInput.focus(), 60);
}

/* ==========================================================================
   筛选
   ========================================================================== */

function openFilterPanel(open = true) {
  if (open) {
    filterSite.value = state.filters.site;
    filterLang.value = state.filters.lang;
    filterAfter.value = state.filters.after;
    filterExclude.value = state.filters.exclude;
    filterPanel.hidden = false;
    filterToggle.setAttribute('aria-expanded', 'true');
    window.setTimeout(() => filterSite.focus(), 30);
  } else {
    filterPanel.hidden = true;
    filterToggle.setAttribute('aria-expanded', 'false');
  }
}

function closeFilterPanel(returnFocus = true) {
  if (filterPanel.hidden) return;
  filterPanel.hidden = true;
  filterToggle.setAttribute('aria-expanded', 'false');
  if (returnFocus) filterToggle.focus();
}

function applyFilters(event) {
  event.preventDefault();

  const site = normalizeSite(filterSite.value);
  if (filterSite.value.trim() && !isValidSite(site)) {
    showToast('站点格式不正确，请填写类似 github.com 的域名。', 'error');
    filterSite.focus();
    return;
  }

  state.filters = {
    site,
    lang: ['zh', 'en'].includes(filterLang.value) ? filterLang.value : '',
    after: ['week', 'month', 'year'].includes(filterAfter.value) ? filterAfter.value : '',
    exclude: filterExclude.value.trim().replace(/[\s,，]+/g, ' ').slice(0, 80),
  };
  state.page = 1;
  closeFilterPanel(false);
  runSearch({ pushUrl: true, recordHistory: true, scroll: true });
}

function resetFilters() {
  filterSite.value = '';
  filterLang.value = '';
  filterAfter.value = '';
  filterExclude.value = '';
  state.filters = emptyFilters();
  state.page = 1;
  closeFilterPanel(false);
  runSearch({ pushUrl: true, recordHistory: true, scroll: true });
}

function clearFilter(key) {
  if (key === 'all') state.filters = emptyFilters();
  else if (key in state.filters) state.filters[key] = '';
  state.page = 1;
  runSearch({ pushUrl: true, recordHistory: true, scroll: true });
}

function applyTab(tab) {
  const next = { ...state.filters };
  if (tab === 'all') {
    next.lang = '';
    next.after = '';
  } else if (tab === 'zh') {
    next.lang = 'zh';
    next.after = '';
  } else if (tab === 'en') {
    next.lang = 'en';
    next.after = '';
  } else if (tab === 'recent') {
    next.lang = '';
    next.after = 'year';
  }

  if (JSON.stringify(next) === JSON.stringify(state.filters)) return;
  state.filters = next;
  state.page = 1;
  closeFilterPanel(false);
  runSearch({ pushUrl: true, recordHistory: true, scroll: true });
}

function activeFilterCount() {
  return Object.values(state.filters).filter(Boolean).length;
}

function normalizeSite(value) {
  let site = String(value || '').trim().toLowerCase();
  if (!site) return '';
  site = site
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0]
    .replace(/\.+$/, '');
  return site.slice(0, 100);
}

function isValidSite(site) {
  return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(site);
}

/* ==========================================================================
   正文预览
   ========================================================================== */

async function openPreview(result) {
  if (!result) {
    showToast('没有找到这条结果，请刷新后重试。', 'error');
    return;
  }
  lastPreviewTrigger = document.activeElement;
  previewController?.abort();
  previewController = new AbortController();
  const controller = previewController;

  const host = hostnameOf(result.url);
  previewSite.textContent = result.site_name || host;
  previewMeta.textContent = formatBreadcrumb(result.url);
  previewTitle.textContent = result.title;
  previewOpen.href = result.url;
  previewBody.innerHTML = `
    <div class="preview-loading" aria-label="正在抓取正文">
      <div class="sk"></div>
      <div class="sk"></div>
      <div class="sk"></div>
      <div class="sk"></div>
    </div>`;

  previewOverlay.hidden = false;
  previewDrawer.setAttribute('aria-hidden', 'false');
  document.body.classList.add('no-scroll');
  window.requestAnimationFrame(() => {
    previewOverlay.classList.add('is-open');
    previewDrawer.classList.add('is-open');
  });
  $('#closePreviewBtn').focus({ preventScroll: true });

  try {
    const response = await fetch('/api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ url: result.url }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (controller.signal.aborted) return;

    if (!response.ok) {
      throw new Error(data?.error?.message || '抓取正文失败。');
    }

    const title = data.title || result.title;
    const content = typeof data.content === 'string' ? data.content : '';
    let notice = '';
    if (data.demo) {
      notice =
        '<div class="preview-notice">演示正文：当前服务以 DEMO_MODE 运行。配置 API Key 后将通过 Fetch API 抓取真实网页。</div>';
    } else if (data.truncated) {
      notice = '<div class="preview-notice">正文较长，已截取前 120,000 个字符。</div>';
    }

    previewTitle.textContent = title;
    previewMeta.textContent = `${host} · ${formatDuration(data.tookMs || 0)}`;
    previewBody.innerHTML =
      notice +
      (content.trim()
        ? renderMarkdown(content)
        : '<p>该页面没有可提取的正文内容。</p>');
  } catch (error) {
    if (controller.signal.aborted) return;
    previewBody.innerHTML = `
      <div class="state">
        <div class="state-icon error">${iconMarkup('i-alert')}</div>
        <h2>无法读取正文</h2>
        <p>${escapeHtml(error.message || '该网页可能不允许抓取，或暂时无法访问。')}</p>
        <div class="state-actions">
          <a class="ghost-btn" href="${escapeHtml(result.url)}" target="_blank" rel="noopener noreferrer">打开原文</a>
        </div>
      </div>`;
  }
}

function closePreview() {
  previewController?.abort();
  previewController = null;
  previewDrawer.classList.remove('is-open');
  previewOverlay.classList.remove('is-open');

  window.setTimeout(() => {
    if (previewDrawer.classList.contains('is-open')) return;
    previewOverlay.hidden = true;
    previewDrawer.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('no-scroll');
  }, 300);

  if (lastPreviewTrigger && lastPreviewTrigger.isConnected) {
    lastPreviewTrigger.focus({ preventScroll: true });
  }
}

/* ==========================================================================
   历史记录
   ========================================================================== */

function loadHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.q === 'string' && item.q.trim())
      .slice(0, 8);
  } catch {
    return [];
  }
}

function addHistory() {
  const entry = {
    q: state.query,
    site: state.filters.site,
    lang: state.filters.lang,
    after: state.filters.after,
    exclude: state.filters.exclude,
    at: Date.now(),
  };

  const list = loadHistory().filter(
    (item) =>
      !(
        item.q === entry.q &&
        (item.site || '') === entry.site &&
        (item.lang || '') === entry.lang &&
        (item.after || '') === entry.after &&
        (item.exclude || '') === entry.exclude
      ),
  );
  list.unshift(entry);

  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 8)));
  } catch {
    /* 隐私模式可能禁用 localStorage，忽略即可 */
  }
  renderHistory();
}

function renderHistory() {
  const list = loadHistory();
  const clearButton = $('#clearHistoryBtn');
  clearButton.hidden = list.length === 0;

  if (!list.length) {
    $('#recentList').innerHTML = `
      <div class="recent-empty">
        <strong>还没有搜索记录</strong>
        <span>搜索过的内容会显示在这里，只保存在本机浏览器。</span>
      </div>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  list.slice(0, 5).forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recent-item';

    const detail = historyDetail(item);
    button.title = detail ? `${item.q} · ${detail}` : item.q;
    button.append(createIcon('i-clock'));

    const text = document.createElement('span');
    text.textContent = item.q;
    button.append(text);

    const arrow = createIcon('i-chevron-right', 'icon recent-arrow');
    button.append(arrow);

    button.addEventListener('click', () => {
      state.query = item.q.trim().slice(0, MAX_QUERY_CHARS);
      state.filters = {
        site: normalizeSite(item.site || ''),
        lang: ['zh', 'en'].includes(item.lang) ? item.lang : '',
        after: ['week', 'month', 'year'].includes(item.after) ? item.after : '',
        exclude: String(item.exclude || '').slice(0, 80),
      };
      state.page = 1;
      syncInputs(state.query);
      showView('results');
      runSearch({ pushUrl: true, recordHistory: false, scroll: true });
    });

    fragment.append(button);
  });

  $('#recentList').replaceChildren(fragment);
}

function historyDetail(item) {
  const parts = [];
  if (item.site) parts.push(`site:${item.site}`);
  if (item.lang) parts.push(`lang:${item.lang}`);
  if (item.after) parts.push(`after:${item.after}`);
  if (item.exclude) parts.push(`-${item.exclude}`);
  return parts.join(' · ');
}

/* ==========================================================================
   主题
   ========================================================================== */

function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* ignore */
  }
  updateThemeButtons();
}

function updateThemeButtons() {
  const dark = currentTheme() === 'dark';
  $$('.theme-toggle').forEach((button) => {
    button.setAttribute('aria-label', dark ? '切换浅色模式' : '切换深色模式');
    button.title = dark ? '切换浅色模式' : '切换深色模式';
  });
}

/* ==========================================================================
   交互事件
   ========================================================================== */

function bindEvents() {
  landingForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitSearch(landingInput.value);
  });

  resultsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitSearch(resultsInput.value);
  });

  resultsInput.addEventListener('input', updateClearButtons);
  resultsClear.addEventListener('click', () => {
    resultsInput.value = '';
    updateClearButtons();
    resultsInput.focus();
  });

  $$('.quick-chip').forEach((button) => {
    button.addEventListener('click', () => {
      const query = button.dataset.query || '';
      landingInput.value = query;
      submitSearch(query);
    });
  });

  $$('.operator').forEach((button) => {
    button.addEventListener('click', () => insertToken(button.dataset.operator || ''));
  });

  $$('.tip').forEach((button) => {
    button.addEventListener('click', () => insertToken(button.dataset.tip || ''));
  });

  $$('.theme-toggle').forEach((button) => {
    button.addEventListener('click', toggleTheme);
  });

  $('#landingSettingsBtn').addEventListener('click', openSettings);
  $('#resultsSettingsBtn').addEventListener('click', openSettings);
  $('#keyBannerBtn').addEventListener('click', openSettings);

  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => applyTab(tab.dataset.tab || 'all'));
  });

  filterToggle.addEventListener('click', () => {
    openFilterPanel(filterPanel.hidden);
  });
  filterForm.addEventListener('submit', applyFilters);
  $('#filterReset').addEventListener('click', resetFilters);

  filterChips.addEventListener('click', (event) => {
    const button = event.target.closest('[data-clear]');
    if (!button) return;
    clearFilter(button.dataset.clear);
  });

  perPageSelect.addEventListener('change', () => {
    const value = Number(perPageSelect.value);
    state.perPage = PER_PAGE_OPTIONS.includes(value) ? value : 10;
    state.page = 1;
    render();
    writeUrl({ push: false });
  });

  paginationEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-page]');
    if (!button || button.disabled) return;
    const page = Number(button.dataset.page);
    if (!Number.isInteger(page) || page < 1) return;
    state.page = page;
    render();
    writeUrl({ push: false });
    scrollToResultsTop();
  });

  resultsContent.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;

    if (action === 'fetch') {
      const result = state.results.find((item) => item.url === button.dataset.url);
      openPreview(result);
    } else if (action === 'copy') {
      copyLink(button.dataset.url || '');
    } else if (action === 'retry') {
      runSearch({ pushUrl: false, recordHistory: false, scroll: true });
    } else if (action === 'settings') {
      openSettings();
    } else if (action === 'focus-search') {
      resultsInput.focus();
      resultsInput.select();
    } else if (action === 'clear-filters') {
      state.filters = emptyFilters();
      state.page = 1;
      runSearch({ pushUrl: true, recordHistory: true, scroll: true });
    }
  });

  $('#clearHistoryBtn').addEventListener('click', () => {
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {
      /* ignore */
    }
    renderHistory();
    showToast('搜索记录已清空。', 'success');
  });

  $('#closeSettingsBtn').addEventListener('click', () => settingsDialog.close());
  $('#cancelSettingsBtn').addEventListener('click', () => settingsDialog.close());
  keyForm.addEventListener('submit', saveKey);
  clearKeyBtn.addEventListener('click', clearRuntimeKey);

  toggleKeyBtn.addEventListener('click', () => {
    const reveal = keyInput.type === 'password';
    keyInput.type = reveal ? 'text' : 'password';
    toggleKeyBtn.textContent = reveal ? '隐藏' : '显示';
  });

  settingsDialog.addEventListener('click', (event) => {
    if (event.target === settingsDialog) settingsDialog.close();
  });

  $('#closePreviewBtn').addEventListener('click', closePreview);
  previewOverlay.addEventListener('click', closePreview);

  window.addEventListener('popstate', () => {
    searchController?.abort();
    searchToken += 1;
    readStateFromUrl();
    if (state.query) {
      showView('results');
      runSearch({ pushUrl: false, recordHistory: false, scroll: false });
    } else {
      showView('landing');
    }
  });

  document.addEventListener('pointerdown', (event) => {
    if (filterPanel.hidden) return;
    if (filterPanel.contains(event.target) || filterToggle.contains(event.target)) return;
    closeFilterPanel(false);
  });

  document.addEventListener('keydown', (event) => {
    if (settingsDialog.open) return;

    if (event.key === 'Escape') {
      if (previewDrawer.classList.contains('is-open')) {
        closePreview();
        return;
      }
      if (!filterPanel.hidden) {
        closeFilterPanel(true);
        return;
      }
    }

    if (previewDrawer.classList.contains('is-open')) return;

    const isShortcut =
      event.key === '/' ||
      ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k');

    if (isShortcut && !isTypingTarget(event.target)) {
      event.preventDefault();
      const input = activeInput();
      input.focus();
      input.select();
    }
  });
}

function insertToken(token) {
  if (!token) return;
  const input = activeInput();
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const prefix = before && !/\s$/.test(before) ? ' ' : '';
  const suffix = after && !/^\s/.test(after) ? ' ' : '';
  input.value = `${before}${prefix}${token}${suffix}${after}`;
  const position = before.length + prefix.length + token.length;
  input.focus();
  input.setSelectionRange(position, position);
  updateClearButtons();
}

function activeInput() {
  return state.view === 'results' ? resultsInput : landingInput;
}

function updateClearButtons() {
  resultsClear.hidden = !resultsInput.value;
}

function syncInputs(query) {
  if (document.activeElement !== landingInput) landingInput.value = query;
  if (document.activeElement !== resultsInput) resultsInput.value = query;
  updateClearButtons();
}

function scrollToResultsTop() {
  const top = $('#resultsMain').getBoundingClientRect().top + window.scrollY - 110;
  window.scrollTo({ top: Math.max(0, top), behavior: REDUCED_MOTION ? 'auto' : 'smooth' });
}

/* ==========================================================================
   工具函数
   ========================================================================== */

function createIcon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
}

function iconMarkup(name, className = 'icon') {
  return `<svg class="${className}" aria-hidden="true"><use href="#${name}"></use></svg>`;
}

function appendHighlighted(element, text, query) {
  const terms = extractTerms(query);
  if (!terms.length) {
    element.textContent = text;
    return;
  }

  const pattern = new RegExp(terms.map(escapeRegExp).join('|'), 'gi');
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      element.append(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const mark = document.createElement('mark');
    mark.textContent = match[0];
    element.append(mark);
    lastIndex = match.index + match[0].length;
    if (match[0].length === 0) pattern.lastIndex += 1;
  }

  if (lastIndex < text.length) {
    element.append(document.createTextNode(text.slice(lastIndex)));
  }
}

function extractTerms(query) {
  const cleaned = String(query || '')
    .replace(/(?:site|lang|after|before):\S+/gi, ' ')
    .replace(/(^|\s)-\S+/g, ' ')
    .replace(/["“”']/g, ' ')
    .trim();

  return [...new Set(cleaned.split(/\s+/).filter((term) => term.length >= 2))]
    .slice(0, 6)
    .sort((a, b) => b.length - a.length);
}

function formatBreadcrumb(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, '');
    const segments = url.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      })
      .slice(0, 3);
    return segments.length ? `${host} › ${segments.join(' › ')}` : host;
  } catch {
    return rawUrl;
  }
}

function hostnameOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return dateFormatter.format(date);
}

function formatDuration(milliseconds) {
  const ms = Number(milliseconds) || 0;
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(2)} 秒`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    const entities = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isTypingTarget(target) {
  if (!target || !(target instanceof Element)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}

async function copyLink(url) {
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    showToast('链接已复制。', 'success');
  } catch {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = url;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.append(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
      showToast('链接已复制。', 'success');
    } catch {
      showToast('复制失败，请手动复制。', 'error');
    }
  }
}

function showToast(message, type = 'info') {
  window.clearTimeout(toastTimer);
  toastEl.hidden = false;
  toastEl.className = 'toast';
  toastEl.textContent = message;
  if (type === 'error') toastEl.classList.add('is-error');
  else if (type === 'success') toastEl.classList.add('is-success');

  window.requestAnimationFrame(() => {
    toastEl.classList.add('is-visible');
  });

  toastTimer = window.setTimeout(() => {
    toastEl.classList.remove('is-visible');
    window.setTimeout(() => {
      if (!toastEl.classList.contains('is-visible')) toastEl.hidden = true;
    }, 220);
  }, 3000);
}

/* ==========================================================================
   Markdown 渲染（先转义，再生成受控 HTML）
   ========================================================================== */

function renderMarkdown(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let paragraph = [];
  let quote = [];
  let listType = null;
  let codeLines = null;
  let codeLang = '';

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };

  const flushQuote = () => {
    if (!quote.length) return;
    out.push(`<blockquote><p>${quote.map(renderInline).join('<br>')}</p></blockquote>`);
    quote = [];
  };

  const flushList = () => {
    if (!listType) return;
    out.push(`</${listType}>`);
    listType = null;
  };

  const flushAll = () => {
    flushParagraph();
    flushQuote();
    flushList();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s*```(.*)$/);

    if (codeLines) {
      if (fence) {
        const langClass = codeLang ? ` class="language-${escapeHtml(codeLang)}"` : '';
        out.push(`<pre><code${langClass}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = null;
        codeLang = '';
      } else {
        codeLines.push(line);
      }
      continue;
    }

    if (fence) {
      flushAll();
      codeLines = [];
      codeLang = (fence[1] || '').trim().split(/\s+/)[0].replace(/[^\w+-]/g, '');
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushAll();
      out.push('<hr>');
      continue;
    }

    if (line.includes('|') && isTableSeparator(lines[index + 1] || '')) {
      flushAll();
      const headers = splitTableRow(line);
      const rows = [];
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor].trim() && lines[cursor].includes('|')) {
        rows.push(splitTableRow(lines[cursor]));
        cursor += 1;
      }

      const headHtml = headers
        .map((cell) => `<th>${renderInline(cell)}</th>`)
        .join('');
      const bodyHtml = rows
        .map(
          (row) =>
            `<tr>${headers
              .map((_, cellIndex) => `<td>${renderInline(row[cellIndex] || '')}</td>`)
              .join('')}</tr>`,
        )
        .join('');
      out.push(`<table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`);
      index = cursor - 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushParagraph();
      flushList();
      quote.push(line.replace(/^>\s?/, ''));
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (unordered || ordered) {
      flushParagraph();
      flushQuote();
      const type = unordered ? 'ul' : 'ol';
      if (listType !== type) {
        flushList();
        out.push(`<${type}>`);
        listType = type;
      }
      out.push(`<li>${renderInline((unordered || ordered)[1])}</li>`);
      continue;
    }

    flushQuote();
    flushList();
    paragraph.push(line.trim());
  }

  if (codeLines) {
    out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  }
  flushAll();

  return out.join('\n');
}

function renderInline(raw) {
  let text = escapeHtml(raw);
  const codeSpans = [];

  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    codeSpans.push(`<code>${code}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });

  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');

  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, rawUrl) => {
    try {
      const url = new URL(rawUrl.replace(/&amp;/g, '&'));
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return label;
      return `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    } catch {
      return match;
    }
  });

  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  text = text.replace(/\u0000(\d+)\u0000/g, (_, index) => codeSpans[Number(index)] || '');

  return text;
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}
