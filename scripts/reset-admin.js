"use strict";

/**
 * Reset (or create) the admin account from the command line.
 *
 *   node scripts/reset-admin.js [username] [password]
 *
 * - With no args: resets the first admin's password to a freshly generated one.
 * - With a username that exists: resets that admin (optionally to the given password).
 * - With a username that doesn't exist: creates it.
 * If no password is given, a strong random one is generated and printed once.
 */

require("dotenv").config();

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { open } = require("../lib/db");

const [, , argUser, argPass] = process.argv;
const store = open();

const password = argPass || crypto.randomBytes(12).toString("base64url");

const target = argUser
  ? store.getAdminByUsername(argUser)
  : store.db.prepare("SELECT * FROM admins ORDER BY id LIMIT 1").get();

let username;
if (target) {
  username = argUser || target.username;
  store.updateAdminCredentials(target.id, { username, password });
  console.log(`Updated admin "${username}".`);
} else {
  username = argUser || "admin";
  store.createAdmin(username, bcrypt.hashSync(password, 10));
  console.log(`Created admin "${username}".`);
}

if (argPass) {
  console.log("Password: (the value you provided)");
} else {
  console.log(`Generated password (shown once): ${password}`);
}

process.exit(0);
