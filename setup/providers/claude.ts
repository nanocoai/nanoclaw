import { registerSetupProvider } from './registry.js';

registerSetupProvider({
  value: 'claude',
  label: 'Claude',
  hint: 'default — Anthropic subscription or API key',
});
