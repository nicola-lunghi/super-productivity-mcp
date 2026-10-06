import { SuperProductivityClient } from '../src/sp-client.js';
import { loadConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { errorResponse, successResponse, testConfig, testLogger, testTask } from './helpers.js';

describe('SuperProductivityClient', () => {
  it('calls health without an Authorization header', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(successResponse({ server: 'up', rendererReady: true }));
    const client = new SuperProductivityClient(loadConfig({}), testLogger(), fetchMock);

    await expect(client.health()).resolves.toEqual({ server: 'up', rendererReady: true });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
  });

  it('sends the token and exact filters when listing tasks', async () => {
    const task = testTask();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successResponse([task]));
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);

    await expect(
      client.listTasks({
        query: 'Example',
        projectId: 'project-1',
        tagId: 'TODAY',
        includeDone: true,
        source: 'all',
      }),
    ).resolves.toEqual([task]);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain('/tasks?');
    expect(String(url)).toContain('query=Example');
    expect(String(url)).toContain('projectId=project-1');
    expect(String(url)).toContain('tagId=TODAY');
    expect(String(url)).toContain('includeDone=true');
    expect(String(url)).toContain('source=all');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
  });

  it('lists projects and tags with an optional title query', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(successResponse([{ id: 'project-1', title: 'Home Renovation' }]))
      .mockResolvedValueOnce(successResponse([{ id: 'tag-1', title: 'urgent' }]));
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);

    await expect(client.listProjects('home & renovation')).resolves.toEqual([
      { id: 'project-1', title: 'Home Renovation' },
    ]);
    await expect(client.listTags()).resolves.toEqual([{ id: 'tag-1', title: 'urgent' }]);

    const [projectsUrl, projectsInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(projectsUrl)).toBe('http://127.0.0.1:3876/projects?query=home+%26+renovation');
    expect(new Headers(projectsInit?.headers).get('authorization')).toBe('Bearer test-token');
    const [tagsUrl] = fetchMock.mock.calls[1] ?? [];
    expect(String(tagsUrl)).toBe('http://127.0.0.1:3876/tags');
  });

  it('rejects project and tag lists with an unexpected shape', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(successResponse([{ id: 'project-1' }]))
      .mockResolvedValueOnce(successResponse({ id: 'tag-1', title: 'not a list' }));
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);

    await expect(client.listProjects()).rejects.toMatchObject({ code: 'SP_INVALID_RESPONSE' });
    await expect(client.listTags()).rejects.toMatchObject({ code: 'SP_INVALID_RESPONSE' });
  });

  it('supports the released unauthenticated API when no token is configured', async () => {
    const task = testTask();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successResponse([task]));
    const client = new SuperProductivityClient(loadConfig({}), testLogger(), fetchMock);

    await expect(client.listTasks()).resolves.toEqual([task]);

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
  });

  it('maps official API errors to explicit application errors', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(errorResponse('TASK_NOT_FOUND', 'Task not found', 404));
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);

    const error = await client.getTask('missing').catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('TASK_NOT_FOUND');
    expect((error as AppError).status).toBe(404);
  });

  it('serializes task updates as a PATCH without leaking unrelated fields', async () => {
    const task = testTask({ isDone: true });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successResponse(task));
    const client = new SuperProductivityClient(testConfig(), testLogger(), fetchMock);

    await client.updateTask('task-1', { isDone: true });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://127.0.0.1:3876/tasks/task-1');
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe(JSON.stringify({ isDone: true }));
  });
});
