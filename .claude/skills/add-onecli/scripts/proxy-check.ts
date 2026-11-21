// SKILL.md's "Check the proxy address" step; no run-directly guard, so a checkout path with a space still prints.
import { proxyCheck } from './remote-proxy.js';

console.log(JSON.stringify(await proxyCheck()));
