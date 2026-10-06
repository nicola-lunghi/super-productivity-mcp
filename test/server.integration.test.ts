import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import { createMcpServer } from '../src/server.js';
import { SuperProductivityClient } from '../src/sp-client.js';
import {
  errorResponse,
  responseText,
  successResponse,
  testConfig,
  testLogger,
  testTask,
} from './helpers.js';

const connect = async (fetchMock: typeof fetch) => {
  const logger = testLogger();
  const config = testConfig();
  const client = new SuperProductivityClient(config, logger, fetchMock);
  const server = createMcpServer({ config, client, logger });
  const mcpClient = new Client({ name: 'test-client', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);
  return {
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const result = await mcpClient.callTool({ name, arguments: args });
      return { isError: result.isError === true, data: JSON.parse(responseText(result)) };
    },
    close: async () => {
      await mcpClient.close();
      await server.close();
    },
  };
};

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
        'list_projects',
        'list_tags',
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
      if (url.pathname === '/projects') {
        return successResponse([{ id: 'project-old', title: 'Old', isArchived: true }]);
      }
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

    for (const projectId of ['project-old', 'project-missing']) {
      const badProject = await mcpClient.callTool({
        name: 'ensure_github_issue_task',
        arguments: { issue: 'example/app#9', projectId },
      });
      expect(JSON.parse(responseText(badProject)).error.code).toBe('PROJECT_NOT_FOUND');
    }
    expect(posts).toHaveLength(1);
    await mcpClient.close();
    await server.close();
  });

  it('lists projects and tags and filters task search by tag', async () => {
    const task = testTask({ id: 'task-1', title: 'Paint', tagIds: ['tag-1'] });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/projects') {
        expect(url.searchParams.get('query')).toBe('home');
        return successResponse([
          { id: 'project-1', title: 'Home Renovation', isArchived: false, taskIds: ['task-1'] },
        ]);
      }
      if (url.pathname === '/tags') {
        expect(url.search).toBe('');
        return successResponse([{ id: 'tag-1', title: 'urgent', color: '#f00' }]);
      }
      if (url.pathname === '/tasks') {
        expect(url.searchParams.get('tagId')).toBe('tag-1');
        return successResponse([task]);
      }
      throw new Error(`Unexpected mocked API request: ${init?.method ?? 'GET'} ${url.pathname}`);
    });
    const logger = testLogger();
    const config = testConfig();
    const client = new SuperProductivityClient(config, logger, fetchMock);
    const server = createMcpServer({ config, client, logger });
    const mcpClient = new Client({ name: 'test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

    const projectsResult = await mcpClient.callTool({
      name: 'list_projects',
      arguments: { query: 'home' },
    });
    expect(JSON.parse(responseText(projectsResult))).toEqual({
      projects: [{ id: 'project-1', title: 'Home Renovation', isArchived: false }],
      total: 1,
    });

    const tagsResult = await mcpClient.callTool({ name: 'list_tags', arguments: {} });
    expect(JSON.parse(responseText(tagsResult))).toEqual({
      tags: [{ id: 'tag-1', title: 'urgent' }],
      total: 1,
    });

    const searchResult = await mcpClient.callTool({
      name: 'search_tasks',
      arguments: { tagId: 'tag-1' },
    });
    expect(JSON.parse(responseText(searchResult)).tasks[0].id).toBe('task-1');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    await mcpClient.close();
    await server.close();
  });

  it('reports list errors as tool errors and rejects invalid input', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/projects') {
        return successResponse([{ id: 'project-1', title: 'Inbox' }]);
      }
      if (url.pathname === '/tags') {
        return errorResponse('UNAUTHORIZED', 'Authorization token required', 401);
      }
      throw new Error(`Unexpected mocked API request: ${init?.method ?? 'GET'} ${url.pathname}`);
    });
    const logger = testLogger();
    const config = testConfig();
    const client = new SuperProductivityClient(config, logger, fetchMock);
    const server = createMcpServer({ config, client, logger });
    const mcpClient = new Client({ name: 'test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

    const projectsResult = await mcpClient.callTool({ name: 'list_projects', arguments: {} });
    expect(JSON.parse(responseText(projectsResult)).projects).toEqual([
      { id: 'project-1', title: 'Inbox', isArchived: false },
    ]);

    const tagsResult = await mcpClient.callTool({ name: 'list_tags', arguments: {} });
    expect(tagsResult.isError).toBe(true);
    expect(JSON.parse(responseText(tagsResult)).error.code).toBe('UNAUTHORIZED');

    const invalidResult = await mcpClient.callTool({
      name: 'list_projects',
      arguments: { query: '   ' },
    });
    expect(invalidResult.isError).toBe(true);
    const unknownFieldResult = await mcpClient.callTool({
      name: 'list_tags',
      arguments: { includeTaskOrder: true },
    });
    expect(unknownFieldResult.isError).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await mcpClient.close();
    await server.close();
  });

  it('trims list queries and only sends a tag filter when one is given', async () => {
    const requests: URL[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      return successResponse([]);
    });
    const logger = testLogger();
    const config = testConfig();
    const client = new SuperProductivityClient(config, logger, fetchMock);
    const server = createMcpServer({ config, client, logger });
    const mcpClient = new Client({ name: 'test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

    const tagsResult = await mcpClient.callTool({
      name: 'list_tags',
      arguments: { query: '  urg  ' },
    });
    expect(JSON.parse(responseText(tagsResult))).toEqual({ tags: [], total: 0 });
    await mcpClient.callTool({ name: 'search_tasks', arguments: { query: 'Paint' } });

    expect(requests.map((url) => url.pathname)).toEqual(['/tags', '/tasks']);
    expect(requests[0]?.searchParams.get('query')).toBe('urg');
    expect(requests[1]?.searchParams.has('tagId')).toBe(false);
    await mcpClient.close();
    await server.close();
  });

  it('reads one task with notes, tags, deadlines, and optional subtasks', async () => {
    const parent = testTask({
      id: 'parent-1',
      title: 'Paint the hallway',
      notes: 'Two coats needed',
      tagIds: ['tag-1'],
      deadlineDay: '2026-10-09',
      subTaskIds: ['sub-1'],
    });
    const subTask = testTask({ id: 'sub-1', title: 'Buy primer', parentId: 'parent-1' });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const { pathname } = new URL(String(input));
      if (pathname === '/tasks/parent-1') return successResponse(parent);
      if (pathname === '/tasks/sub-1') return successResponse(subTask);
      return errorResponse('TASK_NOT_FOUND', 'Task not found', 404);
    });
    const mcp = await connect(fetchMock);

    const plain = await mcp.call('get_task', { taskId: 'parent-1' });
    expect(plain.data.task).toMatchObject({
      id: 'parent-1',
      notes: 'Two coats needed',
      tagIds: ['tag-1'],
      deadlineDay: '2026-10-09',
      deadlineWithTime: null,
      subTaskIds: ['sub-1'],
    });
    expect(plain.data).not.toHaveProperty('subTasks');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const withSubTasks = await mcp.call('get_task', { taskId: 'parent-1', includeSubTasks: true });
    expect(withSubTasks.data.subTasks).toEqual([
      expect.objectContaining({ id: 'sub-1', title: 'Buy primer', parentId: 'parent-1' }),
    ]);

    const missing = await mcp.call('get_task', { taskId: 'nope' });
    expect(missing.isError).toBe(true);
    expect(missing.data.error.code).toBe('TASK_NOT_FOUND');
    await mcp.close();
  });
});
