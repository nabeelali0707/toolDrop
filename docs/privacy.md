# toolDrop Recorder privacy policy

::: info Status
This policy covers the toolDrop Recorder Chrome extension, planned for Phase 4. It describes how the extension is designed to handle data.
:::

The toolDrop Recorder lets you record a task in your browser once, so toolDrop can turn it into a tool.

## What the extension collects

Only while you are recording, and only in the tab you are recording:

- the clicks and typing you do on the page, and which elements they touch;
- the network requests the page makes, with their responses;
- snapshots of the page's structure (its accessibility tree).

Nothing is collected when you are not recording.

## Where the data goes

Recordings are sent only to **your own toolDrop server**, by default `http://127.0.0.1:3000` on your computer, or to the server address you set. They are never sent to the toolDrop project or anyone else.

## What the extension does not do

- No analytics, no tracking and no advertising.
- No selling or sharing data with third parties.
- Passwords you type while recording are not kept in the recording. Mark them as sign-in fields, and toolDrop stores them encrypted in its vault instead.

## Permissions

The extension asks only for the permissions recording needs: access to the tab you record, and the debugger interface to read that tab's network traffic while recording.

## Changes and contact

Changes to this policy are listed in the project's [changelog](https://github.com/nabeelali0707/toolDrop/blob/main/CHANGELOG.md). Questions: open an issue at [github.com/nabeelali0707/toolDrop](https://github.com/nabeelali0707/toolDrop/issues).
