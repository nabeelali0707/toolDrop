# toolDrop Recorder privacy policy

::: info Status
This policy covers the toolDrop Recorder Chrome extension, available since Phase 4.
:::

The toolDrop Recorder lets you record a task in your browser once, so toolDrop can turn it into a tool.

## What the extension collects

Only while you are recording, and only in the tab you started recording in:

- the clicks you make, the values you type or pick, and the page you start on;
- for each element you touch, how to find it again: its role and name, test id, text and CSS selector;
- the table, list or text you mark as the data.

What you type into a password field is never kept. Nothing is collected when you are not recording, and the extension does not record network traffic.

## Where the data goes

The recording stays in your browser's session storage until you upload or download it, and is gone when Chrome closes. When you upload it, it goes only to **your own toolDrop server**: by default `http://127.0.0.1:3000` on your computer, or the address you set. It is never sent to the toolDrop project or anyone else.

The extension remembers your server's address. The API key you enter stays in session storage only, until Chrome closes.

## What the extension does not do

- No analytics, no tracking and no advertising.
- No selling or sharing data with third parties.
- It does not keep passwords. To let toolDrop sign in for you, save the login with `tooldrop logins add`, which keeps it encrypted in toolDrop's vault.

## Permissions

- **activeTab** and **scripting:** to put the recorder into the tab you record, after you click the toolDrop icon.
- **storage:** to keep the recording until you upload it, and your server's address.
- **Access to `127.0.0.1` and `localhost`:** to reach a toolDrop server on your computer.
- **Access to another site** only if you set a toolDrop server there, asked for when you upload.

## Changes and contact

Changes to this policy are listed in the project's [changelog](https://github.com/nabeelali0707/toolDrop/blob/main/CHANGELOG.md). Questions: open an issue at [github.com/nabeelali0707/toolDrop](https://github.com/nabeelali0707/toolDrop/issues).
