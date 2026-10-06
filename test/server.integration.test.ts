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

const connect = async (
  fetchMock: typeof fetch,
  configOverrides: Parameters<typeof testConfig>[0] = {},
) => {
  const logger = testLogger();
  const config = testConfig(configOverrides);
  const client = new SuperProductivityClient(config, logger, fetchMock);
  const server = createMcpServer({ config, client, logger });
  const mcpClient = new Client({ name: 'test-client', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);
  return {
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const result = await mcpClient.callTool({ name, arguments: args });
      const text = responseText(result);
      // Schema validation errors come back from the SDK as plain text, not JSON.
      const data = text.startsWith('{') ? JSON.parse(text) : { text };
      return { isError: result.isError === true, data };
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

describe('create_task', () => {
  const projects = [
    { id: 'INBOX_PROJECT', title: 'Inbox', isArchived: false },
    { id: 'project-home', title: 'Home Renovation', isArchived: false },
    { id: 'project-work-1', title: 'Work', isArchived: false },
    { id: 'project-work-2', title: 'work', isArchived: false },
    { id: 'project-old', title: 'Old', isArchived: true },
  ];
  const tags = [
    { id: 'TODAY', title: 'Today' },
    { id: 'tag-errands', title: 'errands' },
    { id: 'tag-urgent', title: 'urgent' },
  ];

  const apiMock = () => {
    const posts: Record<string, unknown>[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const { pathname } = new URL(String(input));
      if (pathname === '/projects') return successResponse(projects);
      if (pathname === '/tags') return successResponse(tags);
      if (pathname === '/tasks' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        return successResponse(testTask({ id: 'new-task', ...body }), 201);
      }
      throw new Error(`Unexpected mocked API request: ${init?.method ?? 'GET'} ${pathname}`);
    });
    return { fetchMock, posts };
  };

  it('creates a literal Inbox task and overrides every view-dependent default', async () => {
    const { fetchMock, posts } = apiMock();
    const mcp = await connect(fetchMock);

    const result = await mcp.call('create_task', { title: 'Call the plumber' });
    expect(result.isError).toBe(false);
    expect(result.data.task).toMatchObject({ id: 'new-task', projectId: 'INBOX_PROJECT' });
    expect(posts).toEqual([
      {
        title: 'Call the plumber',
        projectId: 'INBOX_PROJECT',
        tagIds: [],
        dueDay: null,
        isIgnoreShortSyntax: true,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await mcp.close();
  });

  it('resolves exact project and tag names and converts due time and estimate', async () => {
    const { fetchMock, posts } = apiMock();
    const mcp = await connect(fetchMock);

    const result = await mcp.call('create_task', {
      title: 'Paint the hallway',
      notes: 'Use the matte finish',
      projectName: '  home RENOVATION ',
      tagNames: ['errands', 'URGENT', 'errands'],
      dueAt: '2026-10-09T15:00:00+02:00',
      timeEstimateMinutes: 30,
    });
    expect(result.isError).toBe(false);
    expect(posts[0]).toEqual({
      title: 'Paint the hallway',
      projectId: 'project-home',
      tagIds: ['tag-errands', 'tag-urgent'],
      dueDay: null,
      dueWithTime: Date.parse('2026-10-09T13:00:00Z'),
      notes: 'Use the matte finish',
      timeEstimate: 1_800_000,
      isIgnoreShortSyntax: true,
    });
    await mcp.close();
  });

  it.each([
    [{ projectName: 'work' }, 'AMBIGUOUS_NAME'],
    [{ projectName: 'Nope' }, 'PROJECT_NOT_FOUND'],
    [{ projectId: 'project-old' }, 'PROJECT_NOT_FOUND'],
    [{ projectName: 'Old' }, 'PROJECT_NOT_FOUND'],
    [{ projectId: 'project-home', projectName: 'Home Renovation' }, 'INVALID_INPUT'],
    [{ tagNames: ['missing'] }, 'TAG_NOT_FOUND'],
    [{ tagIds: ['tag-nope'] }, 'TAG_NOT_FOUND'],
    [{ tagIds: ['TODAY'] }, 'INVALID_INPUT'],
    [{ tagNames: ['Today'] }, 'INVALID_INPUT'],
    [{ dueDay: '2026-10-09', dueAt: '2026-10-09T10:00:00Z' }, 'INVALID_INPUT'],
    [{ parentId: 'parent-1', projectName: 'Home Renovation' }, 'INVALID_INPUT'],
  ])('rejects %j with %s and creates nothing', async (args, code) => {
    const { fetchMock, posts } = apiMock();
    const mcp = await connect(fetchMock);

    const result = await mcp.call('create_task', { title: 'Task', ...args });
    expect(result.isError).toBe(true);
    expect(result.data.error.code).toBe(code);
    expect(posts).toEqual([]);
    await mcp.close();
  });

  it.each([{ dueDay: '2026-02-30' }, { dueAt: '2026-10-09T10:00:00' }, { title: '   ' }])(
    'rejects invalid input %j before calling the API',
    async (args) => {
      const { fetchMock } = apiMock();
      const mcp = await connect(fetchMock);

      const result = await mcp.call('create_task', { title: 'Task', ...args });
      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      await mcp.close();
    },
  );

  it('rejects titles with short syntax unless titles are stored literally', async () => {
    const { fetchMock, posts } = apiMock();
    const strict = await connect(fetchMock);

    const rejected = await strict.call('create_task', { title: 'Paint #urgent @fri 30m' });
    expect(rejected.isError).toBe(true);
    expect(rejected.data.error.code).toBe('TITLE_HAS_SHORT_SYNTAX');
    expect(rejected.data.error.message).toContain('"#urgent", "@fri", "30m"');
    const subTask = await strict.call('create_task', { title: '+Home', parentId: 'parent-1' });
    expect(subTask.data.error.code).toBe('TITLE_HAS_SHORT_SYNTAX');
    expect(posts).toEqual([]);
    await strict.close();

    const literal = await connect(fetchMock, { literalTitles: true });
    const created = await literal.call('create_task', { title: 'Paint #urgent @fri 30m' });
    expect(created.isError).toBe(false);
    expect(posts[0]).toMatchObject({ title: 'Paint #urgent @fri 30m', isIgnoreShortSyntax: true });
    await literal.close();
  });

  it('creates a subtask without sending inherited project or tag fields', async () => {
    const { fetchMock, posts } = apiMock();
    const mcp = await connect(fetchMock);

    const result = await mcp.call('create_task', {
      title: 'Buy primer',
      parentId: 'parent-1',
      dueDay: '2026-10-08',
    });
    expect(result.isError).toBe(false);
    expect(posts).toEqual([
      {
        title: 'Buy primer',
        parentId: 'parent-1',
        dueDay: '2026-10-08',
        dueWithTime: null,
        isIgnoreShortSyntax: true,
      },
    ]);
    await mcp.close();
  });
});
