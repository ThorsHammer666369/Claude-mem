import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { OpenRouterProvider } from '../src/services/worker/OpenRouterProvider';
import { DatabaseManager } from '../src/services/worker/DatabaseManager';
import { SessionManager } from '../src/services/worker/SessionManager';
import { ModeManager } from '../src/services/domain/ModeManager';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager';

const mockMode = {
  name: 'code',
  prompts: {
    init: 'init prompt',
    observation: 'obs prompt',
    summary: 'summary prompt'
  },
  observation_types: [{ id: 'discovery' }, { id: 'bugfix' }],
  observation_concepts: []
};

let loadFromFileSpy: ReturnType<typeof spyOn>;
let modeManagerSpy: ReturnType<typeof spyOn>;

describe('OpenRouterProvider', () => {
  let provider: OpenRouterProvider;
  let originalFetch: typeof global.fetch;
  let mockStoreObservations: ReturnType<typeof mock>;
  let mockDbManager: DatabaseManager;
  let mockSessionManager: SessionManager;

  beforeEach(() => {
    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mockMode,
      loadMode: () => {},
    } as any));

    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_OPENROUTER_API_KEY: 'test-openrouter-key',
      CLAUDE_MEM_OPENROUTER_MODEL: 'openai/gpt-4o-mini',
      CLAUDE_MEM_OPENROUTER_SITE_URL: '',
      CLAUDE_MEM_OPENROUTER_APP_NAME: 'claude-mem-test',
      CLAUDE_MEM_DATA_DIR: '/tmp/claude-mem-test',
    }));

    mockStoreObservations = mock(() => ({
      observationIds: [1],
      summaryId: null,
      createdAtEpoch: Date.now()
    }));

    mockDbManager = {
      getSessionStore: () => ({
        updateMemorySessionId: mock(() => {}),
        storeObservations: mockStoreObservations,
        storeSummary: mock(() => ({ id: 1, createdAtEpoch: Date.now() })),
        markSessionCompleted: mock(() => {}),
        getSessionById: mock(() => ({ memory_session_id: 'mem-session-123' })),
        ensureMemorySessionIdRegistered: mock(() => {}),
      }),
      getChromaSync: () => ({
        syncObservation: mock(() => Promise.resolve()),
        syncSummary: mock(() => Promise.resolve()),
      }),
    } as unknown as DatabaseManager;

    mockSessionManager = {
      getMessageIterator: async function* () { yield* []; },
      confirmClaimedMessages: mock(() => Promise.resolve(0)),
      confirmClaimedMessageIds: mock(() => Promise.resolve(0)),
      retryOrFailClaimedMessages: mock(() => Promise.resolve({ retried: 0, failed: 0 })),
      retryOrFailClaimedMessageIds: mock(() => Promise.resolve({ retried: 0, failed: 0 })),
      getTotalQueueDepth: mock(() => Promise.resolve(0)),
    } as unknown as SessionManager;

    provider = new OpenRouterProvider(mockDbManager, mockSessionManager);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (modeManagerSpy) modeManagerSpy.mockRestore();
    if (loadFromFileSpy) loadFromFileSpy.mockRestore();
    mock.restore();
  });

  function createSession(overrides: Record<string, unknown> = {}) {
    return {
      sessionDbId: 1,
      contentSessionId: 'test-session',
      memorySessionId: 'mem-session-123',
      project: 'test-project',
      userPrompt: 'test prompt',
      conversationHistory: [],
      lastPromptNumber: 1,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      pendingMessages: [],
      abortController: new AbortController(),
      generatorPromise: null,
      currentProvider: null,
      startTime: Date.now(),
      earliestPendingTimestamp: 1700000000000,
      claimedMessageIds: [],
      ...overrides,
    } as any;
  }

  function openRouterResponse(content: string): Response {
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }));
  }

  function observationXml(title: string): string {
    return `
      <observation>
        <type>discovery</type>
        <title>${title}</title>
        <narrative>${title} narrative</narrative>
        <facts></facts>
        <concepts></concepts>
        <files_read></files_read>
        <files_modified></files_modified>
      </observation>
    `;
  }

  it('hard-stops without retrying original ids when a later split part is invalid after storage', async () => {
    loadFromFileSpy.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_OPENROUTER_API_KEY: 'test-openrouter-key',
      CLAUDE_MEM_OPENROUTER_MODEL: 'openai/gpt-4o-mini',
      CLAUDE_MEM_OPENROUTER_SITE_URL: '',
      CLAUDE_MEM_OPENROUTER_APP_NAME: 'claude-mem-test',
      CLAUDE_MEM_DATA_DIR: '/tmp/claude-mem-test',
      CLAUDE_MEM_LLM_QUEUE_MODE: 'auto',
      CLAUDE_MEM_LLM_CONTEXT_SPLIT_ENABLED: 'true',
      CLAUDE_MEM_LLM_CONTEXT_MAX_CHARS: '1200',
      CLAUDE_MEM_LLM_CONTEXT_SPLIT_MAX_PARTS: '20',
    }));

    const confirmClaimedMessages = mock(() => Promise.resolve(1));
    const confirmClaimedMessageIds = mock(() => Promise.resolve(1));
    const retryOrFailClaimedMessageIds = mock(() => Promise.resolve({ retried: 1, failed: 0 }));
    mockSessionManager = {
      ...mockSessionManager,
      getMessageIterator: async function* () {
        yield {
          type: 'observation',
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
          tool_response: {
            stdout: Array.from({ length: 100 }, (_, index) => `openrouter split line ${index + 1}`).join('\n'),
            stderr: '',
            exitCode: 0,
          },
          prompt_number: 2,
          cwd: 'C:/repo',
          _persistentId: 501,
          _originalTimestamp: 1700000000000,
        };
      },
      confirmClaimedMessages,
      confirmClaimedMessageIds,
      retryOrFailClaimedMessageIds,
    } as unknown as SessionManager;
    provider = new OpenRouterProvider(mockDbManager, mockSessionManager);
    const session = createSession({ claimedMessageIds: [501] });

    let requestCount = 0;
    global.fetch = mock(() => {
      requestCount++;
      if (requestCount === 1) {
        return Promise.resolve(openRouterResponse(''));
      }
      if (requestCount === 2) {
        return Promise.resolve(openRouterResponse(observationXml('openrouter split part one')));
      }
      return Promise.resolve(openRouterResponse('plain invalid split output'));
    });

    await expect(provider.startSession(session)).rejects.toThrow(/partial split/i);

    expect(mockStoreObservations).toHaveBeenCalledTimes(1);
    expect(confirmClaimedMessages).not.toHaveBeenCalled();
    expect(confirmClaimedMessageIds).not.toHaveBeenCalled();
    expect(retryOrFailClaimedMessageIds).not.toHaveBeenCalled();
    expect(session.conversationHistory.some((message: any) => message.content === 'plain invalid split output')).toBe(false);
  });

  it('removes the summary prompt from conversation history when the summary provider call fails', async () => {
    const marker = 'OPENROUTER_UNIQUE_SUMMARY_ERROR_MARKER';
    mockSessionManager = {
      ...mockSessionManager,
      getMessageIterator: async function* () {
        yield {
          type: 'summarize',
          last_assistant_message: marker,
          _persistentId: 502,
          _originalTimestamp: 1700000000000,
        };
      },
    } as unknown as SessionManager;
    provider = new OpenRouterProvider(mockDbManager, mockSessionManager);
    const session = createSession({ claimedMessageIds: [502] });

    let requestCount = 0;
    global.fetch = mock(() => {
      requestCount++;
      if (requestCount === 1) {
        return Promise.resolve(openRouterResponse(''));
      }
      return Promise.resolve(new Response(
        'prompt exceeds maximum context length',
        { status: 400 }
      ));
    });

    await expect(provider.startSession(session)).rejects.toThrow(/context overflow/i);

    expect((global.fetch as any).mock.calls.length).toBe(2);
    expect(session.conversationHistory.some((message: any) => message.content.includes(marker))).toBe(false);
  });

  it('records a valid queued observation assistant response only once in conversation history', async () => {
    mockSessionManager = {
      ...mockSessionManager,
      getMessageIterator: async function* () {
        yield {
          type: 'observation',
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
          tool_response: { stdout: 'ok', stderr: '', exitCode: 0 },
          prompt_number: 2,
          cwd: 'C:/repo',
          _persistentId: 503,
          _originalTimestamp: 1700000000000,
        };
      },
      confirmClaimedMessages: mock(() => Promise.resolve(1)),
      confirmClaimedMessageIds: mock(() => Promise.resolve(1)),
    } as unknown as SessionManager;
    provider = new OpenRouterProvider(mockDbManager, mockSessionManager);
    const session = createSession({ claimedMessageIds: [503] });
    const responseXml = observationXml('single openrouter history entry');

    let requestCount = 0;
    global.fetch = mock(() => {
      requestCount++;
      return Promise.resolve(openRouterResponse(requestCount === 1 ? '' : responseXml));
    });

    await provider.startSession(session);

    const matchingAssistantMessages = session.conversationHistory.filter(
      (message: any) => message.role === 'assistant' && message.content === responseXml
    );
    expect(matchingAssistantMessages).toHaveLength(1);
  });
});
