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
        await pool.query('UPDATE items SET stock = $1 WHERE id = $2', [stock, id]);
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
        if (item) { item.stock = stock; write(d); }
      },
    };

    console.log('Using local JSON file database.');
  }
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
