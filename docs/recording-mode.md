# Recording mode

::: info Status
`tooldrop record` is planned for Phase 2, and the Chrome extension for Phase 4.
:::

Instead of letting a model explore a site, do the task once yourself while toolDrop records it. The build then compiles exactly what you did. It is faster, cheaper and far more reliable with local models, so toolDrop prefers recordings whenever they exist.

## What is recorded

- The clicks and typing you do, with several ways to find each element again (by role and name, test id, text and CSS).
- The network requests the page makes, with their responses.
- Snapshots of the page's accessibility tree.

After you stop, mark which typed values are **inputs** (a date range, a status) so the tool takes them as arguments instead of repeating your exact values.

## Record from the terminal

```sh
tooldrop record http://127.0.0.1:4104
```

This opens a browser window. Sign in and do the task, then come back to the terminal to mark the inputs and save. It uses a fresh browser profile, so a site that blocks automated browsers may need the extension instead.

## Record with the Chrome extension

The extension records in your everyday Chrome, with the sign-ins you already have.

1. Download `tooldrop-recorder.zip` from the latest [release](https://github.com/nabeelali0707/toolDrop/releases) and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode**, and choose **Load unpacked**. Select the unzipped folder.
3. Click the toolDrop icon, press **Record**, do the task, then press **Stop** and mark the inputs.

The recording goes to your own toolDrop server (by default `http://127.0.0.1:3000`) and nowhere else. Installing from the Chrome Web Store is optional; "load unpacked" is free and always works. See the [Recorder privacy policy](./privacy).

## Then build from it

Pass the recording to a build: the agent's `build_tool` call takes a `recording_id`, and so does `POST /v1/builds`.
