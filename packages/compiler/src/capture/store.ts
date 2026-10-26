import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Masker } from '@tooldrop/llm';
import type { Capture } from './capture.ts';
import { collectSecrets, maskExchanges, toHar } from './har.ts';

// Captures on disk (SPEC, Data models: captures). Large files live in the data
// directory and the `captures` row holds their paths. Cookies, tokens and other
// secrets are masked before anything is written.

export interface StoredCapture {
  /** Paths relative to the data directory, with forward slashes. */
  har_path: string;
  dom_snapshots: string[];
  ax_trees: string[];
  actions: Capture['actions'];
}

export function writeCapture(
  capture: Capture,
  dataDir: string,
  options: { masker?: Masker; version?: string } = {},
): StoredCapture {
  const masker = collectSecrets(capture.exchanges, options.masker ?? new Masker());
  const relative = `captures/${capture.id}`;
  const dir = join(dataDir, 'captures', capture.id);
  mkdirSync(dir, { recursive: true });
  const write = (name: string, text: string) => {
    writeFileSync(join(dir, name), masker.apply(text));
    return `${relative}/${name}`;
  };

  const har = toHar(maskExchanges(capture.exchanges, masker), capture.started_at, options.version);
  const harPath = write('network.har', JSON.stringify(har, null, 2));
  const domPath = write('page.html', capture.final_html);
  const axPaths = capture.snapshots.map((snapshot, index) =>
    write(`ax-${index}.json`, JSON.stringify(snapshot, null, 2)),
  );
  write(
    'capture.json',
    JSON.stringify(
      {
        id: capture.id,
        start_url: capture.start_url,
        final_url: capture.final_url,
        started_at: capture.started_at,
        actions: capture.actions,
        inputs: capture.inputs,
        target: capture.target,
      },
      null,
      2,
    ),
  );
  return { har_path: harPath, dom_snapshots: [domPath], ax_trees: axPaths, actions: capture.actions };
}
