import type { FastifyInstance } from 'fastify';

// Switches change a fixture the way a real site changes under us (a renamed
// button, a moved field, a new API path), so tests can trigger the cascade and
// the healer. Tests flip them over HTTP:
//
//   GET  /__fixture/switches   current values
//   POST /__fixture/switches   {"searchButtonRenamed": true}
//   POST /__fixture/reset      switches and data back to the start

export interface Switches<T extends Record<string, boolean>> {
  readonly current: Readonly<T>;
  set(patch: Partial<T>): void;
  reset(): void;
}

export function createSwitches<T extends Record<string, boolean>>(defaults: T): Switches<T> {
  let current = { ...defaults };
  return {
    get current() {
      return current;
    },
    set(patch) {
      current = { ...current, ...patch };
    },
    reset() {
      current = { ...defaults };
    },
  };
}

export function registerControls<T extends Record<string, boolean>>(
  app: FastifyInstance,
  switches: Switches<T>,
  onReset: () => void = () => {},
): void {
  app.get('/__fixture/switches', () => switches.current);

  app.post('/__fixture/switches', async (request, reply) => {
    const patch = request.body;
    const known = Object.keys(switches.current);
    const valid =
      typeof patch === 'object' &&
      patch !== null &&
      Object.entries(patch).every(([key, value]) => known.includes(key) && typeof value === 'boolean');
    if (!valid) return reply.code(400).send({ error: 'unknown_switch', known });
    switches.set(patch);
    return switches.current;
  });

  app.post('/__fixture/reset', async (_request, reply) => {
    switches.reset();
    onReset();
    return reply.code(204).send();
  });
}
