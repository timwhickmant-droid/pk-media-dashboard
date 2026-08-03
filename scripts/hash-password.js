// Generates the value for the ADMIN_PASSWORD_HASH environment variable.
//
// Run locally — never commit the output's source password anywhere:
//
//   node scripts/hash-password.js "your new password"
//
// Paste the printed "scrypt:..." line into Vercel > Project Settings >
// Environment Variables as ADMIN_PASSWORD_HASH. The password itself is never
// stored: scrypt is one-way, and the random salt means the same password
// produces a different hash every run.

const crypto = require('crypto');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hash-password.js "your new password"');
  process.exit(1);
}
if (password.length < 12) {
  console.error('Refusing: use at least 12 characters. This is the only gate on your data.');
  process.exit(1);
}

const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(password, salt, 64);

// Print bare values, one per line. Vercel wants the value only — including the
// "NAME=" prefix or wrapping quotes in the value box makes the hash unparseable
// and every login fails with a plain "Invalid credentials".
console.log('\nPaste each value on its own — do NOT include the name or any quotes.\n');
console.log('ADMIN_PASSWORD_HASH  (value below)');
console.log('scrypt:' + salt.toString('hex') + ':' + hash.toString('hex') + '\n');
console.log('SESSION_SECRET  (value below, only if you have not set one yet)');
console.log(crypto.randomBytes(32).toString('hex') + '\n');
