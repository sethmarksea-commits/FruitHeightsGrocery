const express = require('express');
const path    = require('path');
const fs      = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const VALID_USERS  = new Set(['seth', 'lucy']);
const VALID_STOCKS = new Set(['out', 'low', 'good', 'stocked']);

const SEED = [
  ['seth', 'Milk',      'low'],
  ['seth', 'Eggs',      'good'],
  ['seth', 'Bread',     'out'],
  ['seth', 'Coffee',    'stocked'],
  ['seth', 'Butter',    'good'],
  ['seth', 'Pasta',     'low'],
  ['lucy', 'Yogurt',    'good'],
  ['lucy', 'Oat Milk',  'low'],
  ['lucy', 'Green Tea', 'stocked'],
  ['lucy', 'Apples',    'out'],
  ['lucy', 'Rice',      'good'],
  ['lucy', 'Olive Oil', 'stocked'],
];

// ── Storage abstraction (PostgreSQL in prod, JSON file locally) ───
let storage;

async function initStorage() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS items (
        id     SERIAL PRIMARY KEY,
        "user" TEXT NOT NULL,
        name   TEXT NOT NULL,
        stock  TEXT NOT NULL DEFAULT 'good'
      )
    `);

    const { rows } = await pool.query('SELECT COUNT(*) AS n FROM items');
    if (parseInt(rows[0].n) === 0) {
      for (const [user, name, stock] of SEED) {
        await pool.query(
          'INSERT INTO items ("user", name, stock) VALUES ($1, $2, $3)',
          [user, name, stock]
        );
      }
      console.log('Seeded database with initial items.');
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS stock_history (
        id         SERIAL PRIMARY KEY,
        item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        account    TEXT NOT NULL,
        old_level  TEXT NOT NULL,
        new_level  TEXT NOT NULL,
        changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sh_item ON stock_history(item_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sh_at   ON stock_history(changed_at)`);

    const { rows: histCheck } = await pool.query('SELECT COUNT(*) AS n FROM stock_history');
    if (parseInt(histCheck[0].n) === 0) {
      const HIST_CYCLES = {
        'milk': 7, 'eggs': 10, 'bread': 5, 'coffee': 20, 'butter': 14, 'pasta': 25,
        'yogurt': 8, 'oat milk': 9, 'green tea': 30, 'apples': 6, 'rice': 20, 'olive oil': 35,
      };
      const { rows: allItems } = await pool.query('SELECT * FROM items');
      for (const item of allItems) {
        const cd = HIST_CYCLES[item.name.toLowerCase()] ?? 14;
        let daysAgo = 60;
        while (daysAgo > 0) {
          const pts = [
            { old: 'out',     new: 'stocked', d: daysAgo },
            { old: 'stocked', new: 'good',    d: daysAgo - cd * 0.15 },
            { old: 'good',    new: 'low',     d: daysAgo - cd * 0.55 },
            { old: 'low',     new: 'out',     d: daysAgo - cd * 0.95 },
          ];
          for (const pt of pts) {
            if (pt.d > 0) {
              await pool.query(
                `INSERT INTO stock_history (item_id, account, old_level, new_level, changed_at)
                 VALUES ($1, $2, $3, $4, NOW() - ($5 || ' seconds')::interval)`,
                [item.id, item.user, pt.old, pt.new, Math.round(pt.d * 86400)]
              );
            }
          }
          daysAgo -= cd;
        }
      }
      console.log('Seeded stock history.');
    }

    storage = {
      getItems: async (user) => {
        if (user === 'all') {
          const r = await pool.query('SELECT * FROM items ORDER BY "user", name');
          return r.rows;
        }
        const r = await pool.query(
          'SELECT * FROM items WHERE "user" = $1 ORDER BY name',
          [user]
        );
        return r.rows;
      },
      addItem: async (user, name) => {
        const r = await pool.query(
          'INSERT INTO items ("user", name, stock) VALUES ($1, $2, $3) RETURNING *',
          [user, name, 'good']
        );
        return r.rows[0];
      },
      deleteItem: async (id) => {
        await pool.query('DELETE FROM items WHERE id = $1', [id]);
      },
      updateStock: async (id, stock) => {
        const { rows } = await pool.query(
          'SELECT stock, "user" FROM items WHERE id = $1', [id]
        );
        if (!rows.length || rows[0].stock === stock) return;
        const oldStock = rows[0].stock;
        const account  = rows[0].user;
        await pool.query('UPDATE items SET stock = $1 WHERE id = $2', [stock, id]);
        await pool.query(
          'INSERT INTO stock_history (item_id, account, old_level, new_level) VALUES ($1,$2,$3,$4)',
          [id, account, oldStock, stock]
        );
      },
      getHistory: async (user) => {
        const sql = user === 'all'
          ? `SELECT h.id, h.item_id, h.account, h.old_level, h.new_level, h.changed_at, i.name
             FROM stock_history h JOIN items i ON h.item_id = i.id
             ORDER BY h.changed_at`
          : `SELECT h.id, h.item_id, h.account, h.old_level, h.new_level, h.changed_at, i.name
             FROM stock_history h JOIN items i ON h.item_id = i.id
             WHERE h.account = $1 ORDER BY h.changed_at`;
        const r = await pool.query(sql, user === 'all' ? [] : [user]);
        return r.rows;
      },
    };

    console.log('Using PostgreSQL database.');
  } else {
    // Local development — JSON file
    const DB_PATH = path.join(__dirname, 'db.json');

    const read = () => {
      if (!fs.existsSync(DB_PATH)) return { nextId: 1, items: [] };
      return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    };
    const write = (d) => fs.writeFileSync(DB_PATH, JSON.stringify(d, null, 2));

    const data = read();
    if (data.items.length === 0) {
      for (const [user, name, stock] of SEED) {
        data.items.push({ id: data.nextId++, user, name, stock });
      }
      write(data);
    }

    if (!data.history) {
      data.history    = [];
      data.nextHistId = 1;
      const HIST_CYCLES = {
        'milk': 7, 'eggs': 10, 'bread': 5, 'coffee': 20, 'butter': 14, 'pasta': 25,
        'yogurt': 8, 'oat milk': 9, 'green tea': 30, 'apples': 6, 'rice': 20, 'olive oil': 35,
      };
      for (const item of data.items) {
        const cd = HIST_CYCLES[item.name.toLowerCase()] ?? 14;
        let daysAgo = 60;
        while (daysAgo > 0) {
          const pts = [
            { old: 'out',     new: 'stocked', d: daysAgo },
            { old: 'stocked', new: 'good',    d: daysAgo - cd * 0.15 },
            { old: 'good',    new: 'low',     d: daysAgo - cd * 0.55 },
            { old: 'low',     new: 'out',     d: daysAgo - cd * 0.95 },
          ];
          for (const pt of pts) {
            if (pt.d > 0) {
              data.history.push({
                id:         data.nextHistId++,
                item_id:    item.id,
                account:    item.user,
                old_level:  pt.old,
                new_level:  pt.new,
                changed_at: new Date(Date.now() - pt.d * 86400000).toISOString(),
              });
            }
          }
          daysAgo -= cd;
        }
      }
      write(data);
      console.log('Seeded local stock history.');
    }

    storage = {
      getItems: async (user) => {
        const d = read();
        if (user === 'all') {
          return [...d.items].sort((a, b) =>
            a.user !== b.user ? a.user.localeCompare(b.user) : a.name.localeCompare(b.name)
          );
        }
        return d.items
          .filter(i => i.user === user)
          .sort((a, b) => a.name.localeCompare(b.name));
      },
      addItem: async (user, name) => {
        const d = read();
        const item = { id: d.nextId++, user, name, stock: 'good' };
        d.items.push(item);
        write(d);
        return item;
      },
      deleteItem: async (id) => {
        const d = read();
        d.items = d.items.filter(i => i.id !== id);
        write(d);
      },
      updateStock: async (id, stock) => {
        const d = read();
        const item = d.items.find(i => i.id === id);
        if (!item || item.stock === stock) return;
        const oldStock = item.stock;
        item.stock = stock;
        if (!d.history) { d.history = []; d.nextHistId = 1; }
        d.history.push({
          id:         d.nextHistId++,
          item_id:    id,
          account:    item.user,
          old_level:  oldStock,
          new_level:  stock,
          changed_at: new Date().toISOString(),
        });
        write(d);
      },
      getHistory: async (user) => {
        const d = read();
        const activeIds = new Set(d.items.map(i => i.id));
        const enriched = (d.history || [])
          .filter(ev => activeIds.has(ev.item_id))
          .map(ev => {
            const it = d.items.find(i => i.id === ev.item_id);
            return { ...ev, name: it.name };
          });
        if (user === 'all') return enriched.sort((a, b) => a.changed_at.localeCompare(b.changed_at));
        return enriched
          .filter(ev => ev.account === user)
          .sort((a, b) => a.changed_at.localeCompare(b.changed_at));
      },
    };

    console.log('Using local JSON file database.');
  }
}

// ── Trend helpers ─────────────────────────────────────────────────
function findDepletionCycles(itemHist) {
  const cycles = [];
  let restockedAt = null;
  for (const ev of itemHist) {
    if (ev.new_level === 'stocked' || ev.new_level === 'good') {
      restockedAt = new Date(ev.changed_at);
    } else if (ev.new_level === 'out' && restockedAt) {
      const days = (new Date(ev.changed_at) - restockedAt) / 86400000;
      if (days > 0) cycles.push(days);
      restockedAt = null;
    }
  }
  return cycles;
}

function avg(arr) { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null; }

function computeItemStats(item, itemHist) {
  const cycles     = findDepletionCycles(itemHist);
  const cycleCount = cycles.length;
  const avgCycleDays = avg(cycles);

  // Depleted = moved to Out or Low
  const depleteCount = itemHist.filter(
    ev => ev.new_level === 'out' || ev.new_level === 'low'
  ).length;

  // Restock = moved FROM out/low TO good/stocked (actual buying event)
  const restockEvs = itemHist.filter(
    ev => (ev.old_level === 'out' || ev.old_level === 'low') &&
          (ev.new_level === 'good' || ev.new_level === 'stocked')
  );
  const restockCount = restockEvs.length;

  // Average interval between consecutive restock events
  let avgRestockInterval = null;
  if (restockCount >= 2) {
    const times = restockEvs.map(ev => new Date(ev.changed_at).getTime());
    const diffs = [];
    for (let i = 1; i < times.length; i++) diffs.push((times[i] - times[i - 1]) / 86400000);
    avgRestockInterval = avg(diffs);
  }

  // Days since last restock event
  const lastRestockEv = restockEvs.length ? restockEvs[restockEvs.length - 1] : null;
  const daysSince = lastRestockEv
    ? (Date.now() - new Date(lastRestockEv.changed_at)) / 86400000 : null;

  // Runout prediction — only valid when cycleCount >= 2
  const daysUntilOut = (cycleCount >= 2 && avgCycleDays != null && daysSince !== null)
    ? Math.max(0, avgCycleDays - daysSince) : null;

  return { cycleCount, avgCycleDays, depleteCount, restockCount, avgRestockInterval, daysUntilOut, daysSince };
}

function buildHint(stats) {
  if (stats.cycleCount < 2 || !stats.avgCycleDays) return null;
  const cycle = Math.round(stats.avgCycleDays);
  if (stats.daysUntilOut !== null && stats.daysUntilOut < 1.5) return 'Restock soon';
  if (stats.daysUntilOut !== null && stats.daysUntilOut < 3) {
    const d = Math.round(stats.daysUntilOut);
    return `Out in ~${d} day${d === 1 ? '' : 's'}`;
  }
  return `Runs out ~every ${cycle} day${cycle === 1 ? '' : 's'}`;
}

function computeTrends(items, history) {
  const byId = {};
  for (const ev of history) {
    if (!byId[ev.item_id]) byId[ev.item_id] = [];
    byId[ev.item_id].push(ev);
  }
  const stats = {};
  for (const item of items) stats[item.id] = computeItemStats(item, byId[item.id] || []);

  // Runout Prediction gate: >= 2 complete depletion cycles
  const runoutPrediction = items
    .filter(i => stats[i.id].cycleCount >= 2)
    .map(i => ({
      id: i.id, name: i.name, user: i.user ?? i.account, stock: i.stock,
      daysUntilOut: stats[i.id].daysUntilOut,
      avgCycleDays: stats[i.id].avgCycleDays,
    }))
    .sort((a, b) => (a.daysUntilOut ?? Infinity) - (b.daysUntilOut ?? Infinity));

  // Most Frequently Depleted gate: hit Out or Low >= 3 times
  const mostDepleted = items
    .filter(i => stats[i.id].depleteCount >= 3)
    .map(i => ({ id: i.id, name: i.name, user: i.user ?? i.account, depleteCount: stats[i.id].depleteCount }))
    .sort((a, b) => b.depleteCount - a.depleteCount)
    .slice(0, 6);

  // Restock Frequency gate: >= 2 restock events
  const restockFrequency = items
    .filter(i => stats[i.id].restockCount >= 2 && stats[i.id].avgRestockInterval != null)
    .map(i => ({ id: i.id, name: i.name, user: i.user ?? i.account, avgDays: stats[i.id].avgRestockInterval }))
    .sort((a, b) => a.avgDays - b.avgDays);

  // Suggested Restock Schedule gate: same as Runout Prediction (cycleCount >= 2)
  const suggestedSchedule = items
    .filter(i => stats[i.id].cycleCount >= 2)
    .map(i => ({
      id: i.id, name: i.name, user: i.user ?? i.account,
      avgCycleDays: stats[i.id].avgCycleDays,
      daysUntilOut: stats[i.id].daysUntilOut,
    }))
    .sort((a, b) => (a.daysUntilOut ?? Infinity) - (b.daysUntilOut ?? Infinity));

  return { runoutPrediction, mostDepleted, restockFrequency, suggestedSchedule };
}

// ── Routes ────────────────────────────────────────────────────────
app.get('/api/items/:user', async (req, res) => {
  try {
    const { user } = req.params;
    if (user !== 'all' && !VALID_USERS.has(user))
      return res.status(400).json({ error: 'Invalid user' });
    res.json(await storage.getItems(user));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/items', async (req, res) => {
  try {
    const { user, name } = req.body ?? {};
    if (!VALID_USERS.has(user) || typeof name !== 'string' || !name.trim())
      return res.status(400).json({ error: 'Invalid data' });
    res.status(201).json(await storage.addItem(user, name.trim()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/items/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    await storage.deleteItem(id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/items/:id/stock', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { stock } = req.body ?? {};
    if (!Number.isInteger(id) || !VALID_STOCKS.has(stock))
      return res.status(400).json({ error: 'Invalid data' });
    await storage.updateStock(id, stock);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/trends/:user', async (req, res) => {
  try {
    const { user } = req.params;
    if (user !== 'all' && !VALID_USERS.has(user))
      return res.status(400).json({ error: 'Invalid user' });
    const [items, history] = await Promise.all([
      storage.getItems(user),
      storage.getHistory(user),
    ]);
    res.json(computeTrends(items, history));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/hints/:user', async (req, res) => {
  try {
    const { user } = req.params;
    if (!VALID_USERS.has(user))
      return res.status(400).json({ error: 'Invalid user' });
    const [items, history] = await Promise.all([
      storage.getItems(user),
      storage.getHistory(user),
    ]);
    const byId = {};
    for (const ev of history) {
      if (!byId[ev.item_id]) byId[ev.item_id] = [];
      byId[ev.item_id].push(ev);
    }
    const hints = {};
    for (const item of items) {
      const hint = buildHint(computeItemStats(item, byId[item.id] || []));
      if (hint) hints[item.id] = hint;
    }
    res.json(hints);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SPA fallback — serves index.html for any non-API path ────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initStorage()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\nGrocery Tracker → http://localhost:${PORT}\n`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize storage:', err);
    process.exit(1);
  });
