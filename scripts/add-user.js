// Generates a DASHBOARD_USERS entry for a new dashboard account.
//
//   node scripts/add-user.js <username> "<password>"
//
// Prints a JSON array to paste into Vercel > Project Settings > Environment
// Variables as DASHBOARD_USERS. To add further accounts later, put every
// account inside the same array — the variable holds the whole list.
//
// The existing ADMIN_USERNAME / ADMIN_PASSWORD_HASH pair keeps working
// alongside this, so adding accounts never requires re-hashing that password.
//
// Passwords shorter than 12 characters are refused unless --allow-weak is
// passed, because these accounts are the only gate on the revenue data.

const crypto = require('crypto');

const args      = process.argv.slice(2).filter(a => a !== '--allow-weak');
const allowWeak = process.argv.includes('--allow-weak');
const username  = args[0];
const password  = args[1];

if (!username || !password) {
  console.error('Usage: node scripts/add-user.js <username> "<password>" [--allow-weak]');
  process.exit(1);
}
if (password.length < 12 && !allowWeak) {
  console.error('Refusing: "' + username + '" has a ' + password.length + '-character password.');
  console.error('Use at least 12 characters, or pass --allow-weak to override.');
  process.exit(1);
}

const salt = crypto.randomBytes(16);
const hash = 'scrypt:' + salt.toString('hex') + ':' + crypto.scryptSync(password, salt, 64).toString('hex');

if (password.length < 12) {
  console.log('\n[weak password accepted via --allow-weak]');
}
console.log('\nDASHBOARD_USERS  (paste the value below — the whole line, no variable name)\n');
console.log(JSON.stringify([{ username: username, hash: hash }]));
console.log('\nAdding more accounts later? Extend the same array:');
console.log('[{"username":"' + username + '","hash":"scrypt:..."},{"username":"Someone","hash":"scrypt:..."}]\n');
