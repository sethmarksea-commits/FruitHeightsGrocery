// ── State ──────────────────────────────────────────────────────────
let currentUser  = null;
let reviewUser   = null;
let reviewItems  = [];
let reviewIndex  = 0;
let accountItems = [];
let accountHints = {};
let homeItemsMap = new Map(); // id → item (for fast home-list updates)

// ── Stock labels & cycle ────────────────────────────────────────────
const STOCK_LABELS = { out: 'Out', low: 'Low', good: 'Good', stocked: 'Stocked' };
const STOCK_CYCLE  = ['out', 'low', 'good', 'stocked'];

function nextStock(current) {
  return STOCK_CYCLE[(STOCK_CYCLE.indexOf(current) + 1) % STOCK_CYCLE.length];
}

// ── View switching ──────────────────────────────────────────────────
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo(0, 0);
}

function showHome() {
  currentUser = null;
  showView('view-home');
  loadHomeList();
}

// ── HOME list ────────────────────────────────────────────────────────
async function loadHomeList() {
  const res   = await fetch('/api/items/all');
  const items = await res.json();
  homeItemsMap = new Map(items.map(i => [i.id, { ...i }]));
  renderHomeList(items);
}

function renderHomeList(items) {
  const seth = items.filter(i => i.user === 'seth');
  const lucy = items.filter(i => i.user === 'lucy');

  const section = (label, rows) => rows.length === 0 ? '' : `
    <div class="home-section-label">${label}</div>
    ${rows.map(homeRow).join('')}
  `;

  document.getElementById('home-list').innerHTML =
    section('Seth', seth) + section('Lucy', lucy);
}

function homeRow(item) {
  return `
    <div class="home-item-row" onclick="cycleHomeStock(${item.id})">
      <span class="home-item-name">${esc(item.name)}</span>
      <span class="badge badge-${item.stock}" id="hstock-${item.id}">${STOCK_LABELS[item.stock]}</span>
    </div>
  `;
}

async function cycleHomeStock(id) {
  const item = homeItemsMap.get(id);
  if (!item) return;

  const newStock = nextStock(item.stock);
  const res = await fetch(`/api/items/${id}/stock`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ stock: newStock }),
  });

  if (res.ok) {
    item.stock = newStock;
    const el = document.getElementById(`hstock-${id}`);
    if (el) {
      el.textContent = STOCK_LABELS[newStock];
      el.className   = `badge badge-${newStock}`;
    }
    syncToAccountItems(id, newStock);
  }
}

// ── ACCOUNT view ─────────────────────────────────────────────────────
async function openAccount(user) {
  currentUser = user;
  document.getElementById('account-title').textContent = cap(user);
  await loadAccountItems();
  showView('view-account');
}

async function loadAccountItems() {
  const [itemsRes, hintsRes] = await Promise.all([
    fetch(`/api/items/${currentUser}`),
    fetch(`/api/hints/${currentUser}`),
  ]);
  accountItems = await itemsRes.json();
  accountHints = hintsRes.ok ? await hintsRes.json() : {};
  renderItemList();
}

function renderItemList() {
  const list = document.getElementById('item-list');
  if (accountItems.length === 0) {
    list.innerHTML = '<div class="empty-state">No items yet.</div>';
    return;
  }
  list.innerHTML = accountItems.map(item => {
    const hint = accountHints[item.id] || '';
    return `
      <div class="item-row">
        <div class="item-info">
          <span class="item-name">${esc(item.name)}</span>
          ${hint ? `<span class="item-hint">${esc(hint)}</span>` : ''}
        </div>
        <span class="badge badge-${item.stock}">${STOCK_LABELS[item.stock]}</span>
        <button class="delete-btn" onclick="deleteItem(${item.id})">&#x2715;</button>
      </div>
    `;
  }).join('');
}

async function addItem() {
  const input = document.getElementById('new-item-input');
  const name  = input.value.trim();
  if (!name) return;

  const res = await fetch('/api/items', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ user: currentUser, name }),
  });

  if (res.ok) {
    const item = await res.json();
    accountItems.push(item);
    accountItems.sort((a, b) => a.name.localeCompare(b.name));
    input.value = '';
    renderItemList();
  }
}

async function deleteItem(id) {
  const res = await fetch(`/api/items/${id}`, { method: 'DELETE' });
  if (res.ok) {
    accountItems = accountItems.filter(i => i.id !== id);
    renderItemList();
  }
}

// ── REVIEW / Update mode ──────────────────────────────────────────────
async function openReview(user) {
  reviewUser  = user;
  reviewIndex = 0;

  document.getElementById('review-title').textContent =
    user === 'all' ? "Update Stock" : `${cap(user)}`;

  const res   = await fetch(`/api/items/${user}`);
  reviewItems = await res.json();

  if (reviewItems.length === 0) {
    alert('No items to update.');
    return;
  }

  renderReviewCard();
  showView('view-review');
}

function exitReview() {
  reviewUser === 'all' ? showHome() : openAccount(currentUser);
}

function renderReviewCard() {
  const item  = reviewItems[reviewIndex];
  const total = reviewItems.length;

  document.getElementById('review-progress').textContent  = `${reviewIndex + 1} / ${total}`;
  document.getElementById('review-item-name').textContent = item.name;
  document.getElementById('review-item-user').textContent =
    reviewUser === 'all' ? cap(item.user) : '';

  const badge = document.getElementById('review-item-stock');
  badge.textContent = STOCK_LABELS[item.stock];
  badge.className   = `review-current-stock stock-${item.stock}`;

  document.querySelectorAll('.stock-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.stock === item.stock);
  });

  document.getElementById('prev-btn').disabled = reviewIndex === 0;
  document.getElementById('next-btn').disabled = reviewIndex === total - 1;
}

function reviewNav(dir) {
  const next = reviewIndex + dir;
  if (next < 0 || next >= reviewItems.length) return;
  reviewIndex = next;
  renderReviewCard();
}

async function setReviewStock(stock) {
  const item = reviewItems[reviewIndex];
  let saved  = true;

  if (item.stock !== stock) {
    const res = await fetch(`/api/items/${item.id}/stock`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ stock }),
    });
    if (!res.ok) return;

    reviewItems[reviewIndex].stock = stock;
    syncToAccountItems(item.id, stock);
    syncToHomeList(item.id, stock);
  }

  // Brief visual confirmation, then auto-advance
  renderReviewCard();
  setTimeout(() => {
    if (reviewIndex < reviewItems.length - 1) {
      reviewIndex++;
      renderReviewCard();
    } else {
      exitReview();
    }
  }, 280);
}

// ── Local sync helpers ────────────────────────────────────────────────
function syncToAccountItems(id, stock) {
  const i = accountItems.findIndex(x => x.id === id);
  if (i !== -1) accountItems[i].stock = stock;
}

function syncToHomeList(id, stock) {
  const item = homeItemsMap.get(id);
  if (!item) return;
  item.stock = stock;
  const el = document.getElementById(`hstock-${id}`);
  if (el) {
    el.textContent = STOCK_LABELS[stock];
    el.className   = `stock-text stock-${stock}`;
  }
}

// ── Enter key for add-item ────────────────────────────────────────────
document.getElementById('new-item-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') addItem();
});

// ── Helpers ──────────────────────────────────────────────────────────
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function esc(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── TRENDS view ───────────────────────────────────────────────────────
let trendsUser = 'seth';

async function openTrends() {
  trendsUser = 'seth';
  document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('ttog-seth').classList.add('active');
  showView('view-trends');
  await loadTrends();
}

async function switchTrendsUser(user) {
  trendsUser = user;
  document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`ttog-${user}`).classList.add('active');
  await loadTrends();
}

async function loadTrends() {
  document.getElementById('trends-content').innerHTML =
    '<div class="empty-state">Loading…</div>';
  try {
    const res  = await fetch(`/api/trends/${trendsUser}`);
    const data = await res.json();
    renderTrends(data);
  } catch {
    document.getElementById('trends-content').innerHTML =
      '<div class="empty-state">Could not load trends.</div>';
  }
}

function fmtDays(d) {
  if (d == null) return '—';
  if (d < 0.5) return 'Today';
  const r = Math.round(d);
  return `${r} day${r === 1 ? '' : 's'}`;
}

function renderTrends(data) {
  const { runoutPrediction, mostDepleted, restockFrequency, suggestedSchedule } = data;
  const showUser = trendsUser === 'all';

  function userTag(u) {
    return showUser
      ? ` <span style="opacity:.45;font-weight:400;font-size:.8em">${cap(u)}</span>`
      : '';
  }

  function section(label, rows) {
    if (!rows.length) return '';
    return `<div><div class="trends-section-label">${label}</div>${rows}</div>`;
  }

  const runoutRows = runoutPrediction.map(item => {
    const d   = item.daysUntilOut;
    let cls   = 'safe';
    if (d == null)  cls = '';
    else if (d < 2) cls = 'urgent';
    else if (d < 5) cls = 'warning';
    const label = d != null ? `${fmtDays(d)} left` : `~${Math.round(item.avgCycleDays)}d cycle`;
    return `
      <div class="trends-row">
        <span class="trends-row-name">${esc(item.name)}${userTag(item.user)}</span>
        <span class="trends-row-value ${cls}">${label}</span>
      </div>`;
  }).join('');

  const depletedRows = mostDepleted.map(item => `
    <div class="trends-row">
      <span class="trends-row-name">${esc(item.name)}${userTag(item.user)}</span>
      <span class="trends-row-value">${item.depleteCount}× depleted</span>
    </div>`).join('');

  const freqRows = restockFrequency.map(item => `
    <div class="trends-row">
      <span class="trends-row-name">${esc(item.name)}${userTag(item.user)}</span>
      <span class="trends-row-value">~${Math.round(item.avgDays)}d cycle</span>
    </div>`).join('');

  const scheduleRows = (suggestedSchedule || []).map(item => {
    const d = item.daysUntilOut;
    let cls = '';
    if (d != null && d < 2) cls = 'urgent';
    else if (d != null && d < 5) cls = 'warning';
    const when = d != null && d < 2
      ? 'Restock now'
      : `Every ~${Math.round(item.avgCycleDays)} days`;
    return `
      <div class="trends-row">
        <span class="trends-row-name">${esc(item.name)}${userTag(item.user)}</span>
        <span class="trends-row-value ${cls}">${when}</span>
      </div>`;
  }).join('');

  const html =
    section('Runout Prediction', runoutRows) +
    section('Most Frequently Depleted', depletedRows) +
    section('Restock Frequency', freqRows) +
    section('Suggested Restock Schedule', scheduleRows);

  document.getElementById('trends-content').innerHTML = html || '<div class="empty-state">No trend data yet — keep updating stock levels to see insights.</div>';
}

// ── Initial load ──────────────────────────────────────────────────────
loadHomeList();
