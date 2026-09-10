// Runs automatically once when a GitHub Codespace for this repo is created
// (see .devcontainer/devcontainer.json). Creates a working .env with a
// random session secret and a demo admin login, purely so the app is
// immediately usable for trying it out — never use this for a real deploy,
// see README.md's "Deploying to your VPS" section for that instead.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const envPath = path.join(__dirname, '..', '.env');
const examplePath = path.join(__dirname, '..', '.env.example');

if (fs.existsSync(envPath)) {
  console.log('.env already exists — leaving it untouched.');
  process.exit(0);
}

const DEMO_USERNAME = 'admin';
const DEMO_PASSWORD = 'demo1234';

let env = fs.readFileSync(examplePath, 'utf8');
env = env.replace(/^NODE_ENV=.*$/m, 'NODE_ENV=');
env = env.replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}`);
env = env.replace(/^ADMIN_USERNAME=.*$/m, `ADMIN_USERNAME=${DEMO_USERNAME}`);
env = env.replace(/^ADMIN_PASSWORD_HASH=.*$/m, `ADMIN_PASSWORD_HASH=${bcrypt.hashSync(DEMO_PASSWORD, 10)}`);

fs.writeFileSync(envPath, env);

console.log('\n✅ .env created for this Codespace with a demo admin login:');
console.log(`   Username: ${DEMO_USERNAME}`);
console.log(`   Password: ${DEMO_PASSWORD}`);
console.log('\nRun `npm start`, then open the forwarded port 3000 (make it public in the Ports tab to share the link).');
console.log('This demo login is only for trying the app in this throwaway Codespace — never reuse it for a real deploy.\n');
