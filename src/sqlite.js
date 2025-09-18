import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const SQLITE_PATH = process.env.SQLITE_PATH || './data/automember.sqlite';

// ensure folder
const dir = path.dirname(SQLITE_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

export const db = new Database(SQLITE_PATH);

export async function initDB() {
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS AutoMember_Staging (
      StagingId TEXT PRIMARY KEY,
      OrderId INTEGER NOT NULL,
      OrderCreatedAt TEXT NOT NULL,
      CustomerFirstName TEXT NOT NULL,
      CustomerLastName  TEXT NOT NULL,
      Email TEXT,
      Phone TEXT,
      DOB TEXT,
      AddressLine1 TEXT,
      AddressLine2 TEXT,
      City TEXT,
      Postcode TEXT,
      MembershipProductId INTEGER NOT NULL,
      MembershipProductName TEXT NOT NULL,
      TermMonths INTEGER NOT NULL DEFAULT 12,
      PricePaid REAL NOT NULL DEFAULT 0,
      IsRenewalGuess INTEGER NOT NULL DEFAULT 0,
      Status TEXT NOT NULL DEFAULT 'Pending',
      Notes TEXT,
      CreatedAt TEXT NOT NULL,
      UpdatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS AutoMember_Audit (
      AuditId INTEGER PRIMARY KEY AUTOINCREMENT,
      StagingId TEXT NOT NULL,
      Action TEXT NOT NULL,
      Actor TEXT NOT NULL,
      DiffJson TEXT,
      CreatedAt TEXT NOT NULL
    );
  `);
}
