// ── State ──────────────────────────────────────────────────────────
let currentUser  = null;
let reviewUser   = null;
let reviewItems  = [];
let reviewIndex  = 0;
let accountItems = [];
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
  const res  = await fetch(`/api/items/${currentUser}`);
  accountItems = await res.json();
  renderItemList();
}

function renderItemList() {
  const list = document.getElementById('item-list');
  if (accountItems.length === 0) {
    list.innerHTML = '<div class="empty-state">No items yet.</div>';
    return;
  }
  list.innerHTML = accountItems.map(item => `
    <div class="item-row">
      <span class="item-name">${esc(item.name)}</span>
      <span class="badge badge-${item.stock}">${STOCK_LABELS[item.stock]}</span>
      <button class="delete-btn" onclick="deleteItem(${item.id})">&#x2715;</button>
    </div>
  `).join('');
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

// ── Initial load ──────────────────────────────────────────────────────
loadHomeList();
