# Auth and 2FA

::: info Status
The vault, login recipes, TOTP and human-in-the-loop codes are planned for Phase 3. Email and SMS codes come later.
:::

Credentials are optional. An agent can pass them with a single call, or you can save them in the vault so toolDrop signs in by itself.

## The vault

- Credentials are encrypted at rest with libsodium.
- The master key lives in your OS keychain. When self-hosted, it is a key file mounted at runtime. It is never stored in an image, an environment variable, a log or the database.
- No API ever returns a saved secret. You see only that it exists, such as `password: ••••••••`, never any of its characters.

## Signing in

Each site has a **login recipe**, built like any tool, that ends with a check that you really are signed in (for example, "the account menu is visible"). Sessions are saved and reused, and when one expires, toolDrop signs in again quietly instead of failing your call.

If a login redirects to an identity provider such as Okta or Microsoft, toolDrop asks you once to approve that origin for the site.

## Second factors

toolDrop tries these in order:

1. **TOTP.** Save the authenticator secret, and toolDrop generates codes itself.
2. **Email codes.** toolDrop reads the code from a connected inbox over IMAP, matched by sender and time.
3. **SMS codes,** from your own Android phone (see below). No paid SMS service.
4. **Ask a human.** The job pauses and asks you for the code through your agent or the dashboard.

### SMS codes from your phone

1. Install an open-source SMS forwarder on your Android phone, such as [SMS to URL Forwarder](https://github.com/bogkonstantin/android_income_sms_gateway_webhook) (MIT, from F-Droid).
2. Point it at toolDrop's webhook, `http://<your computer's LAN address>:<port>/v1/sms/inbound`. toolDrop shows the address when you turn SMS codes on.
3. Set the JSON template to `{"from":"%from%","text":"%text%","receivedStamp":"%receivedStamp%"}`, and turn on HMAC-SHA256 signing with the secret toolDrop gives you.
4. Set the sender filter so only your 2FA senders are forwarded.

The message text is never logged or stored. toolDrop keeps only the extracted code, for at most 5 minutes. Messages older than 5 minutes, duplicates and unsigned requests are rejected. Your phone needs to be on the same network as your computer, or reach it through your own VPN.

## Captchas

toolDrop never solves captchas automatically. It pauses and asks you to solve it.
