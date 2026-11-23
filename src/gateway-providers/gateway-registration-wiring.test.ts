import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

/** Exercise the production selection entry point in an isolated module graph, including its barrel. */
it('detects removal of either gateway registration edge instead of silently admitting a session', () => {
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-registration-'));
  try {
    fs.mkdirSync(path.join(directory, 'gateway-providers'));
    fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(directory, 'env.js'), 'export const readEnvFile = () => ({});');
    fs.writeFileSync(path.join(directory, 'log.js'), 'export const log = {info(){}};');
    const compile = (source: string) =>
      ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
        .outputText;
    const entry = fs.readFileSync(path.join(sourceDir, 'index.ts'), 'utf8');
    fs.writeFileSync(
      path.join(directory, 'gateway-providers/gateway-provider-registry.js'),
      compile(fs.readFileSync(path.join(sourceDir, 'gateway-provider-registry.ts'), 'utf8')),
    );
    fs.writeFileSync(
      path.join(directory, 'gateway-providers/fixture.js'),
      `
      import {registerGatewayProvider} from './gateway-provider-registry.js';
      registerGatewayProvider({kind:'fixture',agentSkills:[],sessions:{ensure:async()=>({contribution:{networkAccess:{endpoint:'proxy',target:{kind:'host'}}}})},approvals:{subscribe:async()=>{}}});
    `,
    );
    fs.writeFileSync(
      path.join(directory, 'probe.js'),
      `
      import {getGatewayProvider} from './gateway-providers/index.js';
      try { process.stdout.write(getGatewayProvider().kind); }
      catch (error) { process.stdout.write(error.message); }
    `,
    );
    const probe = (selection: string, installed: string) => {
      fs.writeFileSync(path.join(directory, 'gateway-providers/index.js'), compile(selection));
      fs.writeFileSync(path.join(directory, 'gateway-providers/installed.js'), installed);
      return execFileSync(process.execPath, [path.join(directory, 'probe.js')], {
        env: { ...process.env, NANOCLAW_GATEWAY_PROVIDER: 'fixture' },
        encoding: 'utf8',
      });
    };
    expect(probe(entry, "import './fixture.js';")).toBe('fixture');
    expect(probe(entry.replace("import './installed.js';", ''), "import './fixture.js';")).toContain(
      "no gateway provider is registered for 'fixture'",
    );
    expect(probe(entry, '')).toContain("no gateway provider is registered for 'fixture'");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
