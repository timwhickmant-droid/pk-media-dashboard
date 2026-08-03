// Checks a stored hash against a password, so a failing login can be diagnosed
// without guessing. Run locally:
//
//   node scripts/verify-password.js "<the ADMIN_PASSWORD_HASH value>" "the password"
//
// Copy the hash straight out of Vercel's environment-variable box so this tests
// exactly what the server is using.

const auth = require('../api/_auth.js');

const stored   = process.argv[2];
const password = process.argv[3];

if (!stored || !password) {
  console.error('Usage: node scripts/verify-password.js "<hash>" "<password>"');
  process.exit(1);
}

// Report the malformed-value cases explicitly — these fail as "Invalid
// credentials" at the login screen, which looks identical to a wrong password.
const problems = [];
if (/^ADMIN_PASSWORD_HASH=/.test(stored)) problems.push('starts with "ADMIN_PASSWORD_HASH=" — paste the value only, without the name');
if (/^["']|["']$/.test(stored))           problems.push('is wrapped in quotes — paste it without quotes');
if (!/^scrypt:/.test(stored.replace(/^ADMIN_PASSWORD_HASH=/, '').replace(/^["']|["']$/g, '')))
  problems.push('does not begin with "scrypt:" — it may be truncated or from an older format');
if (stored !== stored.trim())             problems.push('has leading/trailing whitespace');

if (problems.length) {
  console.log('\nProblems found with the stored value:');
  problems.forEach(p => console.log('  - it ' + p));
}

auth.verifyPassword(password, stored.trim()).then(ok => {
  console.log('\nResult: ' + (ok
    ? 'MATCH — this password works with this hash. If login still fails, the'
      + '\n        deployment has not picked up the variable yet (redeploy), or'
      + '\n        ADMIN_USERNAME does not match what you type in the username box.'
    : 'NO MATCH — the server will reject this password.'
      + (problems.length
          ? '\n        Fix the formatting problems listed above first.'
          : '\n        The hash was generated from a different password than the one given here.')));
  console.log('');
});
