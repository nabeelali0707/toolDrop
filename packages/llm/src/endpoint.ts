// Whether prompts leave the machine (DECISIONS.md, D-011). Local means
// loopback or a Compose host; everything else is external, and so are Ollama
// cloud models, even though the local Ollama serves them.

const COMPOSE_HOSTS = new Set(['ollama', 'host.docker.internal']);

export function isLocalEndpoint(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return (
    host === 'localhost' ||
    host === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    COMPOSE_HOSTS.has(host)
  );
}

/** Ollama cloud models are tagged `cloud` or `<size>-cloud`, e.g. `gpt-oss:120b-cloud`. */
export function isCloudModel(model: string): boolean {
  const tag = model.split(':')[1] ?? '';
  return tag === 'cloud' || tag.endsWith('-cloud');
}

export function isExternal(endpoint: string, model: string): boolean {
  return !isLocalEndpoint(endpoint) || isCloudModel(model);
}
