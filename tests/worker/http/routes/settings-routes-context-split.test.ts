import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { Request, Response } from 'express';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let testSettingsPath = '';
let tempLogDir = tmpdir();

mock.module('../../../../src/shared/paths.js', () => ({
  getPackageRoot: () => '/tmp/claude-mem-test',
  paths: {
    settings: () => testSettingsPath,
    logsDir: () => tempLogDir,
  },
}));

mock.module('../../../../src/shared/worker-utils.js', () => ({
  clearPortCache: () => {},
}));

import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';
import { paths } from '../../../../src/shared/paths.js';

interface MockResponse extends Partial<Response> {
  statusCode?: number;
  jsonBody?: unknown;
}

function createMockRes(): MockResponse {
  const res: MockResponse = {
    headersSent: false,
    status: mock((code: number) => {
      res.statusCode = code;
      return res as Response;
    }) as any,
    json: mock((body: unknown) => {
      res.jsonBody = body;
      return res as Response;
    }) as any,
  };
  return res;
}

function captureSettingsPostHandler(routes: SettingsRoutes): (body: Record<string, unknown>) => MockResponse {
  let middleware: ((req: Request, res: Response, next: () => void) => void) | undefined;
  let handler: ((req: Request, res: Response) => void) | undefined;
  const mockApp: any = {
    get: mock(() => {}),
    post: mock((path: string, ...rest: any[]) => {
      if (path !== '/api/settings') return;
      middleware = rest[0];
      handler = rest[1];
    }),
  };
  routes.setupRoutes(mockApp);
  if (!middleware || !handler) throw new Error('Failed to capture /api/settings POST handler');

  return (body: Record<string, unknown>): MockResponse => {
    const req = { body, path: '/api/settings' } as Request;
    const res = createMockRes();
    let nextCalled = false;
    middleware!(req, res as Response, () => {
      nextCalled = true;
    });
    if (nextCalled) handler!(req, res as Response);
    return res;
  };
}

describe('SettingsRoutes context split settings', () => {
  let tempDir: string;
  let postSettings: (body: Record<string, unknown>) => MockResponse;

  beforeEach(() => {
    tempDir = join(tmpdir(), `settings-route-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    testSettingsPath = join(tempDir, 'settings.json');
    (paths as any).settings = () => testSettingsPath;
    (paths as any).logsDir = () => tempLogDir;
    writeFileSync(testSettingsPath, '{}', 'utf-8');
    postSettings = captureSettingsPostHandler(new SettingsRoutes({} as any));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    mock.restore();
  });

  it('persists valid context split settings through the settings allow-list', () => {
    const res = postSettings({
      CLAUDE_MEM_LLM_CONTEXT_SPLIT_ENABLED: 'false',
      CLAUDE_MEM_LLM_CONTEXT_MAX_CHARS: '75000',
      CLAUDE_MEM_LLM_CONTEXT_SPLIT_MAX_PARTS: '12',
    });

    expect(res.statusCode).toBeUndefined();
    expect(res.jsonBody).toEqual({ success: true, message: 'Settings updated successfully' });
    expect(existsSync(testSettingsPath)).toBe(true);

    const saved = JSON.parse(readFileSync(testSettingsPath, 'utf-8'));
    expect(saved.CLAUDE_MEM_LLM_CONTEXT_SPLIT_ENABLED).toBe('false');
    expect(saved.CLAUDE_MEM_LLM_CONTEXT_MAX_CHARS).toBe('75000');
    expect(saved.CLAUDE_MEM_LLM_CONTEXT_SPLIT_MAX_PARTS).toBe('12');
  });

  it('persists valid LLM queue and timing settings through the settings allow-list', () => {
    const queueSettings = {
      CLAUDE_MEM_MAX_CONCURRENT_AGENTS: '1',
      CLAUDE_MEM_LLM_QUEUE_MODE: 'local_safe',
      CLAUDE_MEM_LLM_MIN_SEND_INTERVAL_MS: '1500',
      CLAUDE_MEM_LLM_BATCH_MAX_ITEMS: '1',
      CLAUDE_MEM_LLM_BATCH_MAX_CHARS: '12000',
      CLAUDE_MEM_LLM_COALESCE_WINDOW_MS: '5000',
      CLAUDE_MEM_LLM_ADAPTIVE_BACKOFF: 'true',
      CLAUDE_MEM_LLM_MAX_ATTEMPTS: '3',
      CLAUDE_MEM_QUEUE_HIGH_WATERMARK: '200',
      CLAUDE_MEM_QUEUE_CRITICAL_WATERMARK: '1000',
      CLAUDE_MEM_QUEUE_DROP_POLICY: 'coalesce_low_value',
      CLAUDE_MEM_QUEUE_METRICS_ENABLED: 'true',
      CLAUDE_MEM_LLM_CONTEXT_SPLIT_ENABLED: 'true',
      CLAUDE_MEM_LLM_CONTEXT_MAX_CHARS: '50000',
      CLAUDE_MEM_LLM_CONTEXT_SPLIT_MAX_PARTS: '20',
    };

    const res = postSettings(queueSettings);

    expect(res.statusCode).toBeUndefined();
    expect(res.jsonBody).toEqual({ success: true, message: 'Settings updated successfully' });

    const saved = JSON.parse(readFileSync(testSettingsPath, 'utf-8'));
    for (const [key, value] of Object.entries(queueSettings)) {
      expect(saved[key]).toBe(value);
    }
  });

  it('rejects invalid LLM queue enum values', () => {
    const res = postSettings({
      CLAUDE_MEM_LLM_QUEUE_MODE: 'fast',
    });

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({
      success: false,
      error: 'CLAUDE_MEM_LLM_QUEUE_MODE must be "off", "auto", or "local_safe"',
    });
  });

  it('rejects invalid queue drop policies', () => {
    const res = postSettings({
      CLAUDE_MEM_QUEUE_DROP_POLICY: 'drop_everything',
    });

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({
      success: false,
      error: 'CLAUDE_MEM_QUEUE_DROP_POLICY must be "coalesce_low_value"',
    });
  });

  it('rejects invalid queue boolean values', () => {
    const res = postSettings({
      CLAUDE_MEM_LLM_ADAPTIVE_BACKOFF: 'yes',
    });

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({
      success: false,
      error: 'CLAUDE_MEM_LLM_ADAPTIVE_BACKOFF must be "true" or "false"',
    });
  });

  it('rejects malformed queue numeric strings', () => {
    const res = postSettings({
      CLAUDE_MEM_LLM_MIN_SEND_INTERVAL_MS: '1500ms',
    });

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({
      success: false,
      error: 'CLAUDE_MEM_LLM_MIN_SEND_INTERVAL_MS must be between 0 and 60000',
    });
  });

  it('rejects invalid context split boolean values', () => {
    const res = postSettings({
      CLAUDE_MEM_LLM_CONTEXT_SPLIT_ENABLED: 'yes',
    });

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({
      success: false,
      error: 'CLAUDE_MEM_LLM_CONTEXT_SPLIT_ENABLED must be "true" or "false"',
    });
  });

  it('rejects context max chars outside the safe range', () => {
    const res = postSettings({
      CLAUDE_MEM_LLM_CONTEXT_MAX_CHARS: '999',
    });

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({
      success: false,
      error: 'CLAUDE_MEM_LLM_CONTEXT_MAX_CHARS must be between 1000 and 1000000',
    });
  });

  it('rejects malformed context max chars numeric strings', () => {
    const res = postSettings({
      CLAUDE_MEM_LLM_CONTEXT_MAX_CHARS: '75000abc',
    });

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({
      success: false,
      error: 'CLAUDE_MEM_LLM_CONTEXT_MAX_CHARS must be between 1000 and 1000000',
    });
  });

  it('rejects context split max parts outside the safe range', () => {
    const res = postSettings({
      CLAUDE_MEM_LLM_CONTEXT_SPLIT_MAX_PARTS: '101',
    });

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({
      success: false,
      error: 'CLAUDE_MEM_LLM_CONTEXT_SPLIT_MAX_PARTS must be between 1 and 100',
    });
  });

  it('rejects malformed context split max parts numeric strings', () => {
    const res = postSettings({
      CLAUDE_MEM_LLM_CONTEXT_SPLIT_MAX_PARTS: '12abc',
    });

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({
      success: false,
      error: 'CLAUDE_MEM_LLM_CONTEXT_SPLIT_MAX_PARTS must be between 1 and 100',
    });
  });
});
