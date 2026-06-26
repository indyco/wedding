"use strict";

/**
 * Write a consistent backup of the SQLite database to data/backups/.
 * Safe to run while the server is live (uses SQLite's online backup API).
 *
 *   node scripts/backup-db.js
 */

require("dotenv").config();

const path = require("path");
const fs = require("fs");
const { open } = require("../lib/db");

const store = open();

const dir = path.join(__dirname, "..", "data", "backups");
fs.mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dest = path.join(dir, `wedding-${stamp}.db`);

store.db
  .backup(dest)
  .then(() => {
    console.log("Backup written to", dest);
    process.exit(0);
  })
  .catch((err) => {
    console.error("Backup failed:", err);
    process.exit(1);
  });
