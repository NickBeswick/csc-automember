import express from 'express';
import crypto from 'crypto';
import bodyParser from 'body-parser';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { initDB, db } from './src/sqlite.js';
import { sqlPool, findCandidates, approveRenewal, createCustomerAndApprove } from './src/azure.js';

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

const PORT = process.env.PORT || 8080;
const WC_WEBHOOK_SECRET = process.env.WC_WEBHOOK_SECRET || 'dev';
const JWT_SECRET = process.env.JWT_SECRET || 'dev';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// --- Health / sanity ---
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    sqlite_path: process.env.SQLITE_PATH,
    has_sql: !!process.env.AZURE_SQL_CONN
  });
});

// --- Auth: very light (email only) ---
app.post('/api/login', (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });
  const ok = ADMIN_EMAILS.includes(email.toLowerCase());
  if (!ok) return res.status(403).json({ error: 'Not allowed' });
  const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token });
});

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// --- Woo webhook (Order paid) ---
app.post('/webhooks/woocommerce', (req, res) => {
  const raw = JSON.stringify(req.body || {});
  const sig = req.headers['x-wc-webhook-signature'];
  const expected = crypto.createHmac('sha256', WC_WEBHOOK_SECRET).update(raw, 'utf8').digest('base64');
  if (sig !== expected) return res.status(401).send('Bad signature');

  const order = req.body || {};
  const items = (order.line_items || []).filter(li =>
    (li.categories || []).some(c => (c.slug || '').toLowerCase() === 'membership')
  );
  if (!items.length) return res.json({ ok: true, msg: 'No membership items' });

  const now = new Date();
  const insert = db.prepare(`
    INSERT INTO AutoMember_Staging
    (StagingId, OrderId, OrderCreatedAt, CustomerFirstName, CustomerLastName, Email, Phone,
     MembershipProductId, MembershipProductName, TermMonths, PricePaid, Status, CreatedAt, UpdatedAt)
    VALUES (@StagingId, @OrderId, @OrderCreatedAt, @First, @Last, @Email, @Phone,
            @ProdId, @ProdName, @TermMonths, @PricePaid, 'Pending', @Now, @Now)
  `);

  const termOf = (li) => {
    const m = (li.meta_data || []).find(m => m.key === 'term_months');
    return Number(m?.value || 12);
    };

  const OrderCreatedAt = order.date_created_gmt ? new Date(order.date_created_gmt) : now;

  const tx = db.transaction((rows) => {
    rows.forEach(r => insert.run(r));
  });

  const rows = items.map(li => ({
    StagingId: uuid(),
    OrderId: order.id,
    OrderCreatedAt: OrderCreatedAt.toISOString(),
    First: order.billing?.first_name || '',
    Last: order.billing?.last_name || '',
    Email: order.billing?.email || null,
    Phone: order.billing?.phone || null,
    ProdId: li.product_id,
    ProdName: li.name || '',
    TermMonths: termOf(li),
    PricePaid: Number(li.total || 0),
    Now: now.toISOString()
  }));
  tx(rows);

  res.json({ ok: true, staged: rows.length });
});

// --- Admin APIs ---
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
  // candidate search from till DB
  const candidates = await findCandidates({
    FirstName: row.CustomerFirstName,
    LastName: row.CustomerLastName,
    Email: row.Email,
    Phone: row.Phone,
    DOB: row.DOB || null
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
        last: staging.CustomerLastName,
        email: staging.Email,
        phone: staging.Phone,
        dob: staging.DOB || null,
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
      INSERT INTO AutoMember_Audit (AuditId, StagingId, Action, Actor, DiffJson, CreatedAt)
      VALUES (NULL, ?, ?, ?, ?, ?)
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
      INSERT INTO AutoMember_Audit (AuditId, StagingId, Action, Actor, DiffJson, CreatedAt)
      VALUES (NULL, ?, 'Error', ?, ?, ?)
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
    INSERT INTO AutoMember_Audit (AuditId, StagingId, Action, Actor, DiffJson, CreatedAt)
    VALUES (NULL, ?, 'Rejected', ?, ?, ?)
  `).run(staging.StagingId, 'staff', JSON.stringify({ reason: req.body?.reason || '' }), now);
  res.json({ ok: true });
});

// --- Static staff UI ---
app.use('/', express.static('www')); // serves staff.html at root

// --- Start ---
await initDB();            // ensure SQLite schema
await sqlPool();           // warm up SQL pool (non-fatal if fails; we reconnect on demand)
app.listen(PORT, () => console.log(`AutoMember listening on :${PORT}`));
