# Recording mode

::: info Status
`tooldrop record` and the Chrome extension work today. `tooldrop record` opens a fresh browser, so for now it suits sites that need no sign-in (task 4.11). The extension records in your own Chrome, signed in.
:::

Instead of letting a model explore a site, do the task once yourself while toolDrop records it. The build then compiles exactly what you did. It is faster, cheaper and far more reliable with local models, so toolDrop prefers recordings whenever they exist.

## What is recorded

- The clicks, typing and picks you make, with several ways to find each element again (by role and name, test id, text and CSS).
- The table, list or text you mark as the data.
- Never what you type into a password field.

The build replays your steps in its own browser and records the network itself, so the recording stays small and holds no cookies.

After you stop, mark which typed values are **inputs** (a date range, a status) so the tool takes them as arguments instead of repeating your exact values.

## Record from the terminal

```sh
tooldrop record http://127.0.0.1:4101 --task "List my invoices, filtered by status"
```

This opens a browser window with a small toolDrop bar:

1. Do the task once: search, filter, open pages. Navigate by clicking; an address typed into the bar is not recorded.
2. Click **Mark data**, then the table or list you want.
3. Click **Finish**, then pick and name the inputs in the terminal.

The recording is saved under `~/.tooldrop/recordings`, and the terminal prints the `tooldrop build` command that uses it. `--out file.json` also writes it to a file you can upload with `POST /v1/recordings`. The window uses a fresh browser profile, so a site that blocks automated browsers may need the extension instead.

## Record with the Chrome extension

The extension records in your everyday Chrome, with the sign-ins you already have. It makes the same recordings as `tooldrop record`.

1. Get the extension: download `tooldrop-recorder.zip` from the latest [release](https://github.com/nabeelali0707/toolDrop/releases) and unzip it, or build it from source with `pnpm --filter @tooldrop/extension build` (it lands in `apps/extension/dist`).
2. Open `chrome://extensions`, turn on **Developer mode**, and choose **Load unpacked**. Select the unzipped or `dist` folder.
3. On the site, click the toolDrop icon and press **Start recording**. Do the task, navigating by clicking.
4. In the toolDrop bar on the page, click **Mark data**, then the table or list, then **Finish**.
5. A review page opens. Tick the values the tool should ask for on every call, say what the tool does, and upload. Uploading needs your server's address and an API key from `tooldrop keys create`. **Build the tool now** starts the build; **Download the recording** saves a file for `tooldrop build --recording`.

The recording goes to your own toolDrop server (by default `http://127.0.0.1:3000`) and nowhere else. The build replays it in toolDrop's own browser, so on a site that needs a sign-in, save the login first with `tooldrop logins add`. Installing from the Chrome Web Store is optional; "load unpacked" is free and always works. See the [Recorder privacy policy](./privacy).

## Then build from it

Pass the recording to a build: the agent's `build_tool` call takes a `recording_id`, and so does `POST /v1/builds`.
