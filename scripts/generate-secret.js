// Usage: node scripts/generate-secret.js
// Prints a random 64-character hex string — paste it into .env as SESSION_SECRET.
const crypto = require('crypto');

console.log('\nAdd this line to your .env file:\n');
console.log(`SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}\n`);
