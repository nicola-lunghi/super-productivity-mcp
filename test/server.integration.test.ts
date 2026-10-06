import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import { createMcpServer } from '../src/server.js';
import { SuperProductivityClient } from '../src/sp-client.js';
import { responseText, successResponse, testConfig, testLogger, testTask } from './helpers.js';

describe('MCP server integration over an in-memory transport', () => {
  it('exposes explicit tools and keeps selection separate from Today planning', async () => {
    const today = new Date();
    const todayString = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const task = testTask({ id: 'task-1', title: 'Ship the feature' });
    const updatedTask = testTask({ id: 'task-1', title: 'Ship the feature', dueDay: todayString });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/health' && (init?.method ?? 'GET') === 'GET') {
        return successResponse({ server: 'up', rendererReady: true });
      }
      if (url.pathname === '/tasks' && (init?.method ?? 'GET') === 'GET') {
        return successResponse([task]);
      }
      if (url.pathname === '/tasks/task-1' && init?.method === 'PATCH') {
        expect(init.body).toBe(JSON.stringify({ dueDay: todayString, dueWithTime: null }));
        return successResponse(updatedTask);
      }
      throw new Error(`Unexpected mocked API request: ${init?.method ?? 'GET'} ${url.pathname}`);
    });
    const logger = testLogger();
    const { apiToken, ...config } = testConfig();
    void apiToken;
    const client = new SuperProductivityClient(config, logger, fetchMock);
    const server = createMcpServer({ config, client, logger });
    const mcpClient = new Client({ name: 'test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

    const connectionResult = await mcpClient.callTool({
      name: 'check_connection',
      arguments: {},
    });
    const connection = JSON.parse(responseText(connectionResult));
    expect(connection.connected).toBe(true);
    expect(connection.configured).toBe(true);
    expect(connection.tokenConfigured).toBe(false);

    const tools = await mcpClient.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'health',
        'check_connection',
        'search_tasks',
        'list_today',
        'plan_task_today',
        'start_task',
        'stop_timer',
        'complete_task',
        'get_current_task',
        'ensure_github_issue_task',
      ]),
    );

    const searchResult = await mcpClient.callTool({
      name: 'search_tasks',
      arguments: { query: 'Ship', limit: 10 },
    });
    expect(JSON.parse(responseText(searchResult)).tasks[0].id).toBe('task-1');

    const planResult = await mcpClient.callTool({
      name: 'plan_task_today',
      arguments: { taskId: 'task-1' },
    });
    expect(JSON.parse(responseText(planResult)).plannedForToday).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    await mcpClient.close();
    await server.close();
  });

  it('creates GitHub issue tasks with explicit placement and a literal-safe title', async () => {
    const posts: unknown[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/tasks' && init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return successResponse(testTask({ id: 'gh-task' }), 201);
      }
      if (url.pathname === '/tasks') return successResponse([]);
      throw new Error(`Unexpected mocked API request: ${init?.method ?? 'GET'} ${url.pathname}`);
    });
    const logger = testLogger();
    const config = testConfig();
    const client = new SuperProductivityClient(config, logger, fetchMock);
    const server = createMcpServer({ config, client, logger });
    const mcpClient = new Client({ name: 'test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

    await mcpClient.callTool({
      name: 'ensure_github_issue_task',
      arguments: { issue: 'example/app#7' },
    });
    expect(posts).toEqual([
      {
        title: 'GitHub issue 7 — example/app',
        notes: '<!-- super-productivity-mcp:github example/app#7 -->',
        projectId: 'INBOX_PROJECT',
        tagIds: [],
        dueDay: null,
        isIgnoreShortSyntax: true,
      },
    ]);

    const rejected = await mcpClient.callTool({
      name: 'ensure_github_issue_task',
      arguments: { issue: 'example/app#8', title: 'Review #8' },
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.parse(responseText(rejected)).error.code).toBe('TITLE_HAS_SHORT_SYNTAX');
    expect(posts).toHaveLength(1);
    await mcpClient.close();
    await server.close();
  });
});
