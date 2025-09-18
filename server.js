// server.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import bodyParser from 'body-parser';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';

import { initDB, db } from './src/sqlite.js';
import { sqlPool, findCandidates, approveRenewal, createCustomerAndApprove } from './src/azure.js';

const app = express();
const PORT = process.env.PORT || 8080;

const WC_WEBHOOK_SECRET = process.env.WC_WEBHOOK_SECRET || '';
const JWT_SECRET = process.env.JWT_SECRET || 'dev';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// ---- resolve /www for static files ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'www');

// ---- middleware ----
// NOTE: we DO NOT set global json parser before the Woo route.
// We add a raw parser just for the Woo route below.
app.use(express.static(publicDir)); // serves /www
app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// Health
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    sqlite_path: process.env.SQLITE_PATH,
    has_sql: !!process.env.AZURE_SQL_CONN
  });
});

// ----------- Auth (lightweight email allowlist) -----------
app.use(bodyParser.json()); // safe after Woo route is defined (we define Woo with raw below)

app.post('/api/login', (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });
  if (!ADMIN_EMAILS.includes(String(email).toLowerCase())) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token });
});

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ----------- WooCommerce Webhook (raw body + test toggle) -----------
const rawJson = bodyParser.raw({ type: 'application/json' });

// TEMP toggle while testing. Set to false when secrets match & deliveries show 200.
const SKIP_WC_SIGNATURE = true;

app.post('/webhooks/woocommerce', rawJson, (req, res) => {
  try {
    const raw = req.body; // Buffer of raw bytes
    const sig = req.headers['x-wc-webhook-signature'] || '';

    if (!SKIP_WC_SIGNATURE) {
      const expected = crypto.createHmac('sha256', WC_WEBHOOK_SECRET).update(raw).digest('base64');
      if (sig !== expected) return res.status(401).send('Bad signature');
    }

    const order = JSON.parse(raw.toString('utf8') || '{}');

    // Accept all line_items for now (filter by category/IDs later if desired)
    const items = Array.isArray(order.line_items) ? order.line_items : [];
    if (!items.length) return res.json({ ok: true, msg: 'No line items' });

    const now = new Date();
    const when = order.date_created_gmt ? new Date(order.date_created_gmt) : now;

    const insert = db.prepare(`
      INSERT INTO AutoMember_Staging
        (StagingId, OrderId, OrderCreatedAt, CustomerFirstName, CustomerLastName, Email, Phone,
         MembershipProductId, MembershipProductName, TermMonths, PricePaid, Status, CreatedAt, UpdatedAt)
      VALUES
        (@StagingId, @OrderId, @OrderCreatedAt, @First, @Last, @Email, @Phone,
         @ProdId, @ProdName, @TermMonths, @PricePaid, 'Pending', @Now, @Now)
    `);

    const termOf = (li) => {
      const m = (li.meta_data || []).find(x => x?.key === 'term_months');
      return Number(m?.value || 12);
    };

    const rows = items.map(li => ({
      StagingId: uuid(),
      OrderId: order.id,
      OrderCreatedAt: when.toISOString(),
      First: order.billing?.first_name || '',
      Last:  order.billing?.last_name  || '',
      Email: order.billing?.email || null,
      Phone: order.billing?.phone || null,
      ProdId: li.product_id,
      ProdName: li.name || '',
      TermMonths: termOf(li),
      PricePaid: Number(li.total || 0),
      Now: now.toISOString()
    }));

    const tx = db.transaction((rs) => rs.forEach(r => insert.run(r)));
    tx(rows);

    return res.json({ ok: true, staged: rows.length });
  } catch (e) {
    console.error('Webhook error', e);
    return res.status(500).send('Server error');
  }
});

// ----------- Admin APIs (staging list/detail/approve/reject) -----------
app.get('/api/staging', requireAuth, (req, res) => {
  const status = req.query.status || 'Pending';
  const rows = db.prepare(`
    SELECT StagingId, OrderId, CustomerFirstName, CustomerLastName, Email, Phone,
           MembershipProductName, TermMonths, PricePaid, CreatedAt
    FROM AutoMember_Staging
    WHERE Status = ?
    ORDER BY datetime(CreatedAt) DESC
    LIMIT 200
  `).all(status);
  res.json(rows);
});

app.get('/api/staging/:id', requireAuth, async (req, res) => {
  const row = db.prepare(`SELECT * FROM AutoMember_Staging WHERE StagingId = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  // Candidate lookup against Azure SQL (read-only)
  const candidates = await findCandidates({
    FirstName: row.CustomerFirstName,
    LastName:  row.CustomerLastName,
    Email:     row.Email,
    Phone:     row.Phone,
    DOB:       row.DOB || null
  });

  res.json({ staging: row, candidates });
});

app.post('/api/staging/:id/approve', requireAuth, async (req, res) => {
  const { chosenCustomerID, providedCardNo, createNew } = req.body || {};
  const staging = db.prepare(`SELECT * FROM AutoMember_Staging WHERE StagingId = ? AND Status = 'Pending'`).get(req.params.id);
  if (!staging) return res.status(400).json({ error: 'Not pending or not found' });

  try {
    let outcome;
    if (createNew) {
      outcome = await createCustomerAndApprove({
        first: staging.CustomerFirstName,
        last:  staging.CustomerLastName,
        email: staging.Email,
        phone: staging.Phone,
        dob:   staging.DOB || null,
        providedCardNo
      });
    } else {
      if (!chosenCustomerID) return res.status(400).json({ error: 'chosenCustomerID required (or set createNew:true)' });
      outcome = await approveRenewal({ customerID: Number(chosenCustomerID), providedCardNo });
    }

    // mark approved + audit locally
    const now = new Date().toISOString();
    db.prepare(`UPDATE AutoMember_Staging SET Status='Approved', UpdatedAt=? WHERE StagingId=?`).run(now, staging.StagingId);
    db.prepare(`
      INSERT INTO AutoMember_Audit (StagingId, Action, Actor, DiffJson, CreatedAt)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      staging.StagingId,
      createNew ? 'Upserted' : 'Renewed',
      req.user.email,
      JSON.stringify({ customerID: outcome.customerID, cardNo: outcome.cardNo }),
      now
    );

    res.json({ ok: true, ...outcome });
  } catch (e) {
    // audit error
    db.prepare(`
      INSERT INTO AutoMember_Audit (StagingId, Action, Actor, DiffJson, CreatedAt)
      VALUES (?, 'Error', ?, ?, ?)
    `).run(staging.StagingId, req.user.email, JSON.stringify({ error: String(e.message || e) }), new Date().toISOString());
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/staging/:id/reject', requireAuth, (req, res) => {
  const staging = db.prepare(`SELECT * FROM AutoMember_Staging WHERE StagingId = ? AND Status = 'Pending'`).get(req.params.id);
  if (!staging) return res.status(400).json({ error: 'Not pending or not found' });
  const now = new Date().toISOString();
  db.prepare(`UPDATE AutoMember_Staging SET Status='Rejected', UpdatedAt=? WHERE StagingId=?`).run(now, staging.StagingId);
  db.prepare(`
    INSERT INTO AutoMember_Audit (StagingId, Action, Actor, DiffJson, CreatedAt)
    VALUES (?, 'Rejected', ?, ?, ?)
  `).run(staging.StagingId, req.user?.email || 'staff', JSON.stringify({ reason: '' }), now);
  res.json({ ok: true });
});

// ----------- start server -----------
await initDB();      // ensure SQLite schema exists
try { await sqlPool(); } catch { /* ignore warmup error; we'll reconnect on demand */ }

app.listen(PORT, () => console.log(`AutoMember listening on :${PORT}`));
