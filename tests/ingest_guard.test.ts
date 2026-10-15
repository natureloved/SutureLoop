import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'net';
import { createServer } from 'http';
import { sutureLoopMiddleware } from '../src/middleware/sutureloop.js';
import { config } from '../src/config/env.js';

interface Squatter {
  port: number;
  close: () => Promise<void>;
}

/** Starts a server on an ephemeral port; `handler` decides what it answers. */
function occupy(handler: (req: any, res: any) => void): Promise<Squatter> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ port, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

describe('port ownership', () => {
  let squatter: Squatter | null = null;

  afterEach(async () => {
    if (squatter) await squatter.close();
    squatter = null;
  });

  it('refuses to start when an unrelated application holds the port', async () => {
    squatter = await occupy((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'some-other-app' }));
    });

    const { startServer } = await import('../demo/service/server.js');

    // Previously this logged "Utilizing active service instance" and carried on,
    // letting the demo POST its crash payload to a stranger's API and then
    // report a successful "live re-issue" against that stranger's endpoint.
    await expect(startServer(squatter.port)).rejects.toThrow(/held by another application/);
  });

  it('claims the port when the existing owner is another SutureLoop instance', async () => {
    squatter = await occupy((req, res) => {
      if (req.url !== '/health') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        service: 'billing-service',
        id: 'sutureloop-billing-service'
      }));
    });

    const { startServer } = await import('../demo/service/server.js');
    const handle = await startServer(squatter.port);

    expect(handle.reused).toBe(true);
    expect(handle.server).toBeNull();
  });
});

describe('ingest authorisation', () => {
  it('defaults to auto-heal, so documented behaviour is unchanged', () => {
    expect(config.ingestMode).toBe('auto-heal');
  });
});

describe('middleware -> ingest authentication', () => {
  it('forwards the configured secret so ingest is not silently rejected', async () => {
    const seen: Array<Record<string, any>> = [];
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const warnings: string[] = [];

    globalThis.fetch = (async (_url: any, init: any) => {
      seen.push(init.headers);
      const ok = init?.headers?.['x-sutureloop-secret'] === 'shhh';
      return { ok, status: ok ? 202 : 401, text: async () => (ok ? '' : 'Unauthorized') } as any;
    }) as any;

    process.env.SUTURELOOP_WEBHOOK_SECRET = 'shhh';
    console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };

    try {
      const mw = sutureLoopMiddleware({ serviceName: 'test-service' });
      mw(new Error('boom'), { originalUrl: '/x' } as any, {} as any, () => {});
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      console.warn = originalWarn;
      globalThis.fetch = originalFetch;
      delete process.env.SUTURELOOP_WEBHOOK_SECRET;
    }

    expect(seen[0]['x-sutureloop-secret']).toBe('shhh');
    expect(warnings.join('\n')).not.toContain('rejected');
  });

  it('reports an ingest rejection instead of dropping the crash silently', async () => {
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const warnings: string[] = [];

    // No secret forwarded -> the endpoint answers 401.
    globalThis.fetch = (async () => ({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized'
    })) as any;

    console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };

    try {
      const mw = sutureLoopMiddleware({ serviceName: 'test-service' });
      mw(new Error('boom'), { originalUrl: '/x' } as any, {} as any, () => {});
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      console.warn = originalWarn;
      globalThis.fetch = originalFetch;
    }

    expect(warnings.join('\n')).toContain('HTTP 401');
  });
});