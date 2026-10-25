# FAQ

## Is it really free?

Yes. Every dependency is open source or free to self-host, and no feature needs a paid plan or a paid API key. CI checks the license of every package on every change.

## Do I need an API key for a model?

No. toolDrop runs on local models through Ollama. You can add your own OpenAI-compatible endpoint if you want, but nothing requires one.

## Do my credentials leave my machine?

No. They are encrypted in a local vault. With local models, nothing at all leaves your machine. If you configure an external model API, credentials are masked and personal data is redacted before anything is sent.

## How is this different from a browser agent?

A browser agent asks a model what to do on every request, which is slow and costs tokens each time. toolDrop asks a model once, to **build** a tool. After that the tool is plain code that runs in seconds, gives the same answer every time, and can be tested.

## What happens when a website changes?

The failing call starts a heal: toolDrop finds the step that broke, asks the model for a minimal fix, tests it with saved inputs and publishes a new version, while your call waits. If the fix fails 3 times, the tool is marked degraded and you are told why.

## Which websites work?

Sites you could use in a browser yourself. Each new site shows a reminder to check its terms of service. toolDrop does not get around paywalls or access controls, and never solves captchas automatically.

## Can I share the tools I build?

Tools for public websites can go into the [community recipe library](https://github.com/nabeelali0707/toolDrop/tree/main/recipes). Tools for sites you sign in to stay on your machine with your credentials.

## Which systems does it run on?

Windows, macOS and Linux, with Node.js 24 or newer. A machine with a GPU or Apple Silicon builds tools faster, but tools run fine without one.
