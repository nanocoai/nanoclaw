import { registerSetupProvider } from './registry.js';

registerSetupProvider({
  value: 'opencode',
  label: 'OpenCode',
  hint: 'Open-source provider router',
  runAuth: async () => {
    // Setup can refresh this payload after loading the registry. Load the
    // helper only when called, so an earlier static import cannot cache it.
    const auth = await import('../../scripts/opencode-auth.js');
    await auth.checkOpenCodeInstall();
    await auth.runOpenCodeSetupAuth();
  },
  offerFailureAssist: async (context, projectRoot) => {
    const { offerOpenCodeFailureAssist } = await import('../../scripts/opencode-host.js');
    return offerOpenCodeFailureAssist(context, projectRoot);
  },
  runInstallCheck: async () => {
    const auth = await import('../../scripts/opencode-auth.js');
    await auth.checkOpenCodeInstall();
  },
});
