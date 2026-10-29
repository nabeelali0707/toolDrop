# Auth and 2FA

::: info Status
Since Phase 3: the vault, saved logins, login recipes, session refresh, TOTP codes and codes typed by a person. Since Phase 4: approving an identity provider, and signing in by hand past a captcha. Since Phase 5: SMS codes from your phone, and email codes from your inbox.
:::

Credentials are optional. An agent can pass them with a single call, or you can save them in the vault so toolDrop signs in by itself.

## The vault

- Credentials are encrypted at rest with libsodium.
- The master key lives in your OS keychain. When self-hosted, it is a key file mounted at runtime. It is never stored in an image, an environment variable, a log or the database.
- No API ever returns a saved secret. You see only that it exists, such as `password: ••••••••`, never any of its characters.

## Saving a login

Save it from a terminal, so the password never passes through a chat:

```bash
tooldrop logins add https://shop.example --username ana --totp
```

toolDrop asks for the password, and with `--totp` for the authenticator secret, without showing what you type. Use `--human` instead to type each code yourself when it is needed. Use `--password-stdin` to pipe the password in, for example from a password manager's CLI.

- An agent can save a login with the `add_login` tool, and a REST client with `POST /v1/logins`.
- `tooldrop logins list`, `list_logins` and `GET /v1/logins` show saved logins, masked.
- `tooldrop logins verify <site>` signs in once and saves the session, asking for the code when the login needs one.

## Signing in

Each site has a **login recipe**, built like any tool, that ends with a check that you really are signed in (for example, "the account menu is visible"). Sessions are saved and reused, and when one expires, toolDrop signs in again quietly instead of failing your call.

toolDrop types a login only on the site itself. If signing in leads to an identity provider on another address, such as Okta or Microsoft, it stops and asks you once: during a build as a job question, or in the terminal with `tooldrop logins verify <site>`. Once you allow it, that origin is remembered for the site and never asked about again.

## Second factors

toolDrop tries these in order:

1. **TOTP.** Save the authenticator secret, and toolDrop generates codes itself.
2. **Email codes.** toolDrop reads the code from a connected inbox over IMAP, matched by sender and time. Connect it once with `tooldrop email connect imap.example.com --user you@example.com` (many providers want an app password), then save the login with `--email <sender address>`. The inbox is opened read-only: toolDrop never marks, moves or deletes mail.
3. **SMS codes,** from your own Android phone (see below). No paid SMS service.
4. **Ask a human.** The job pauses and asks you for the code through your agent or the REST API, and from Phase 4 the dashboard. Outside a job, `tooldrop logins verify` asks in the terminal.

### SMS codes from your phone

1. Turn SMS codes on with `tooldrop sms enable`. It shows the webhook address and the signing secret, and `tooldrop serve` then opens the webhook on your computer's local network address. Nothing else of toolDrop is served there.
2. Install an open-source SMS forwarder on your Android phone, such as [SMS to URL Forwarder](https://github.com/bogkonstantin/android_income_sms_gateway_webhook) (MIT, from F-Droid), and point it at that address.
3. Set the JSON template to `{"from":"%from%","text":"%text%","receivedStamp":"%receivedStamp%"}`, and turn on HMAC-SHA256 signing with the secret toolDrop gives you.
4. Set the sender filter so only your 2FA senders are forwarded.
5. Save the login with its sender: `tooldrop logins add https://shop.example --sms "+1 555 555 0100"`.

The message text is never logged or stored. toolDrop keeps only the extracted code, for at most 5 minutes. Messages older than 5 minutes, duplicates and unsigned requests are rejected. Your phone needs to be on the same network as your computer, or reach it through your own VPN. A forwarder that cannot sign may send the secret as a bearer token instead. Codes reach the sign-ins of the process running `tooldrop serve`.

## Captchas

toolDrop never solves a captcha, and uses no solver service. When a sign-in page shows one, toolDrop stops and asks you to sign in yourself:

```sh
tooldrop logins verify https://shop.example --by-hand
```

A browser window opens; sign in, solve the captcha, then press Enter in the terminal. toolDrop keeps that session for its calls. When the session ends, it asks you to sign in by hand again rather than trying the captcha itself. During a build, the build waits on a question until you have done so.
