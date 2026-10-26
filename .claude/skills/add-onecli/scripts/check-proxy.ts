/**
 * The SKILL.md agent-proxy check (`nc:run capture:… effect:fetch`). Prints one
 * JSON line, `{"status":"ok"|"warn"|"skipped","hint":…}`, and always exits 0: the
 * engine parses stdout as JSON and bounces any failure, which would fail the
 * whole gateway install over a warning.
 */
import { checkRemoteProxy, runtimeGateway, skippedCheck, type ProxyCheck } from './remote-proxy.js';

async function check(): Promise<ProxyCheck> {
  // Before the logger loads: its threshold is read once, and stdout must stay JSON.
  process.env.LOG_LEVEL = 'warn';
  const { readEnvFile } = await import('../../../../src/env.js');
  const { url, apiKey } = runtimeGateway(process.env, readEnvFile(['ONECLI_URL', 'ONECLI_API_KEY']));
  if (!url) return skippedCheck('no ONECLI_URL');
  return checkRemoteProxy(url, apiKey);
}

check()
  .catch(() => skippedCheck('the check failed'))
  .then((result) => console.log(JSON.stringify(result)));
