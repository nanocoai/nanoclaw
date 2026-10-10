/**
 * Provider file-transformer registry.
 *
 * Host provider contracts are data-only: a contract that wants core to
 * reconcile an existing file names its transformer as a string, and the
 * payload that owns the transformer registers the implementation here at
 * module scope. Core never names a payload's transformer, and a payload can
 * reconcile its own settings file without editing core.
 *
 * Its own module, not part of `registry.ts`, for the same reason
 * `gateway-provider-registry.ts` is separate from its barrel: the file an
 * overlay appends an import to must not be the file that owns the map
 * (temporal dead zone on the one path nobody exercises until an overlay is
 * installed).
 *
 * Registration order between contract modules and transformer modules is not
 * guaranteed, so contract registration only checks the *shape* of the name.
 * That a named transformer actually exists is the conformance check
 * (`assertProviderHostConformance`), which runs once every payload is loaded.
 */

export interface ProviderFileDiagnostic {
  level: 'warn' | 'error';
  message: string;
  fields?: Record<string, unknown>;
}

export type ProviderFileTransformResult =
  | { kind: 'unchanged'; diagnostics?: readonly ProviderFileDiagnostic[] }
  | { kind: 'replace'; content: string; diagnostics?: readonly ProviderFileDiagnostic[] };

export interface ProviderFileTransformer {
  transform(current: string, filePath: string): ProviderFileTransformResult;
  mapIoFailure(error: unknown, filePath: string): ProviderFileDiagnostic;
}

const transformers = new Map<string, ProviderFileTransformer>();

export function registerProviderFileTransformer(name: string, transformer: ProviderFileTransformer): void {
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Provider file transformer name must be lowercase kebab-case: '${String(name)}'`);
  }
  if (transformers.has(name)) throw new Error(`Provider file transformer already registered: ${name}`);
  transformers.set(name, transformer);
}

export function getProviderFileTransformer(name: string): ProviderFileTransformer | undefined {
  return transformers.get(name);
}

export function listProviderFileTransformerNames(): string[] {
  return [...transformers.keys()];
}

/** Registered names for an error message; never the empty string. */
export function describeRegisteredProviderFileTransformers(): string {
  const names = listProviderFileTransformerNames();
  return names.length ? names.join(', ') : '(none)';
}
