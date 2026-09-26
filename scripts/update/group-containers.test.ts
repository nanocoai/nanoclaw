import { describe, expect, it } from 'vitest';

import { stopGroupContainers } from './group-containers.js';
import { CUTOVER_STOP_GRACE_SECONDS, type CommandRunner } from './service.js';

function fakeRunner(
  responses:
    | Record<string, { ok: boolean; stdout?: string }>
    | ((key: string) => { ok: boolean; stdout?: string } | undefined),
) {
  const calls: string[] = [];
  const lookup = typeof responses === 'function' ? responses : (key: string) => responses[key];
  const runner: CommandRunner = {
    run(command, args) {
      const key = `${command} ${args.join(' ')}`;
      calls.push(key);
      const response = lookup(key);
      if (response && !response.ok) throw new Error(response.stdout ?? 'failed');
      return response?.stdout ?? '';
    },
    tryRun(command, args) {
      const key = `${command} ${args.join(' ')}`;
      calls.push(key);
      return { ok: true, stdout: '', ...lookup(key) };
    },
  };
  return { runner, calls };
}

const filters = '--filter label=nanoclaw-install=slug1 --filter label=nanoclaw-group=ag-1';
const ps = `docker ps -aq ${filters}`;

describe('stopGroupContainers', () => {
  it('stops and removes every container carrying the install and group labels', () => {
    const { runner, calls } = fakeRunner({ [ps]: { ok: true, stdout: 'aaa111\nbbb222\n' } });
    const result = stopGroupContainers({ runtime: 'docker', installSlug: 'slug1', agentGroupId: 'ag-1', runner });
    expect(result).toEqual({
      listed: ['aaa111', 'bbb222'],
      stopped: ['aaa111', 'bbb222'],
      survivors: [],
      failures: [],
    });
    expect(calls).toEqual([
      ps,
      `docker stop -t ${CUTOVER_STOP_GRACE_SECONDS} aaa111 bbb222`,
      'docker rm --force aaa111 bbb222',
    ]);
  });

  it('does nothing when the group has no container', () => {
    const { runner, calls } = fakeRunner({ [ps]: { ok: true, stdout: '' } });
    expect(stopGroupContainers({ runtime: 'docker', installSlug: 'slug1', agentGroupId: 'ag-1', runner })).toEqual({
      listed: [],
      stopped: [],
      survivors: [],
      failures: [],
    });
    expect(calls).toEqual([ps]);
  });

  it('tolerates a container that vanished between list and stop (`--rm` sessions auto-remove)', () => {
    let listings = 0;
    const { runner, calls } = fakeRunner((key) => {
      if (key === ps) return { ok: true, stdout: listings++ === 0 ? 'aaa111' : '' };
      if (key.startsWith('docker stop'))
        return { ok: false, stdout: 'Error response from daemon: No such container: aaa111' };
      if (key.startsWith('docker rm'))
        return { ok: false, stdout: 'Error response from daemon: No such container: aaa111' };
      return undefined;
    });
    const result = stopGroupContainers({ runtime: 'docker', installSlug: 'slug1', agentGroupId: 'ag-1', runner });
    expect(result).toEqual({ listed: ['aaa111'], stopped: ['aaa111'], survivors: [], failures: [] });
    expect(calls).toEqual([ps, `docker stop -t ${CUTOVER_STOP_GRACE_SECONDS} aaa111`, 'docker rm --force aaa111', ps]);
  });

  it('reports the survivor and the errors when the runtime still lists the container', () => {
    const { runner } = fakeRunner((key) => {
      if (key === ps) return { ok: true, stdout: 'aaa111' };
      if (key.startsWith('docker stop')) return { ok: true };
      if (key.startsWith('docker rm')) return { ok: false, stdout: 'permission denied' };
      return undefined;
    });
    const result = stopGroupContainers({ runtime: 'docker', installSlug: 'slug1', agentGroupId: 'ag-1', runner });
    expect(result.failures).toEqual(['docker rm failed: permission denied', 'still listed: aaa111']);
    expect(result.stopped).toEqual([]);
    expect(result.survivors).toEqual(['aaa111']);
  });

  it('counts a container that appeared after the first listing as a survivor, not as stopped', () => {
    let listings = 0;
    const { runner } = fakeRunner((key) => {
      if (key === ps) return { ok: true, stdout: listings++ === 0 ? 'aaa111' : 'late222' };
      if (key.startsWith('docker rm')) return { ok: false, stdout: 'No such container: aaa111' };
      return undefined;
    });
    const result = stopGroupContainers({ runtime: 'docker', installSlug: 'slug1', agentGroupId: 'ag-1', runner });
    expect(result.stopped).toEqual(['aaa111']);
    expect(result.survivors).toEqual(['late222']);
    expect(result.failures).toContain('still listed: late222');
  });

  it('counts nothing as stopped when the re-list fails', () => {
    let listings = 0;
    const { runner } = fakeRunner((key) => {
      if (key === ps) return listings++ === 0 ? { ok: true, stdout: 'aaa111' } : { ok: false, stdout: 'daemon gone' };
      if (key.startsWith('docker stop')) return { ok: false, stdout: 'timeout' };
      if (key.startsWith('docker rm')) return { ok: false, stdout: 'timeout' };
      return undefined;
    });
    const result = stopGroupContainers({ runtime: 'docker', installSlug: 'slug1', agentGroupId: 'ag-1', runner });
    expect(result).toEqual({
      listed: ['aaa111'],
      stopped: [],
      survivors: ['aaa111'],
      failures: ['docker stop failed: timeout', 'docker rm failed: timeout', 'docker ps failed: daemon gone'],
    });
  });

  it('counts a successful forced rm as stopped even when the stop failed', () => {
    const { runner, calls } = fakeRunner((key) => {
      if (key === ps) return { ok: true, stdout: 'aaa111' };
      if (key.startsWith('docker stop')) return { ok: false, stdout: 'timeout' };
      return undefined;
    });
    const result = stopGroupContainers({ runtime: 'docker', installSlug: 'slug1', agentGroupId: 'ag-1', runner });
    expect(result).toEqual({ listed: ['aaa111'], stopped: ['aaa111'], survivors: [], failures: [] });
    expect(calls).toEqual([ps, `docker stop -t ${CUTOVER_STOP_GRACE_SECONDS} aaa111`, 'docker rm --force aaa111']);
  });

  it('reports a runtime that cannot be asked, and stops nothing', () => {
    const { runner, calls } = fakeRunner({ [ps]: { ok: false, stdout: 'Cannot connect to the Docker daemon' } });
    const result = stopGroupContainers({ runtime: 'docker', installSlug: 'slug1', agentGroupId: 'ag-1', runner });
    expect(result).toEqual({
      listed: [],
      stopped: [],
      survivors: [],
      failures: ['docker ps failed: Cannot connect to the Docker daemon'],
    });
    expect(calls).toEqual([ps]);
  });
});
