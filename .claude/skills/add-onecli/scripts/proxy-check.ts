// Run by SKILL.md's "Check the proxy address" step: prints the verdict as
// JSON for the step's capture. No run-directly guard, so a checkout path
// with a space still prints it.
import { proxyCheck } from './remote-proxy.js';

console.log(JSON.stringify(await proxyCheck()));
