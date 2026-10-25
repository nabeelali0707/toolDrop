// Starts the three fixture sites on fixed ports for manual testing:
// `pnpm fixtures`. Tests start their own copies on free ports instead.
import { startHtmlAppFixture } from '../fixtures/html-app/src/server.ts';
import { startJsonApiFixture } from '../fixtures/json-api/src/server.ts';
import { FIXTURE_ACCOUNT, startLoginTotpFixture } from '../fixtures/login-totp/src/server.ts';

const running = [
  { name: 'JSON API app', fixture: await startJsonApiFixture(4101) },
  { name: 'Server-rendered app', fixture: await startHtmlAppFixture(4102) },
  { name: 'Login + TOTP app', fixture: await startLoginTotpFixture(4103) },
];

for (const { name, fixture } of running) console.log(`${name.padEnd(21)}${fixture.url}`);
console.log(`\nTest account: ${FIXTURE_ACCOUNT.username} / ${FIXTURE_ACCOUNT.password}`);
console.log(`TOTP secret:  ${FIXTURE_ACCOUNT.totpSecret} (add it to any authenticator app)`);
console.log('Switches:     POST /__fixture/switches, POST /__fixture/reset. Ctrl+C stops.');

process.once('SIGINT', () => {
  void Promise.all(running.map(({ fixture }) => fixture.close())).then(() => process.exit(0));
});
