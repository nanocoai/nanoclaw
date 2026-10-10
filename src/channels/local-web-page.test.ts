import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('local web page assets', () => {
  it('labels unset model and effort choices as Default', () => {
    const html = fs.readFileSync(path.join(process.cwd(), 'src/channels/local-web-page.html'), 'utf8');

    expect(html).toContain('placeholder="Default"');
    expect(html).toContain('<option value="">Default</option>');
    expect(html).not.toContain('Provider default');
  });

  it('keeps the current chat contract behind one split stylesheet entry', () => {
    const root = path.join(process.cwd(), 'src/channels');
    const html = fs.readFileSync(path.join(root, 'local-web-page.html'), 'utf8');
    const script = fs.readFileSync(path.join(root, 'local-web-page.js'), 'utf8');
    const shellStyles = fs.readFileSync(path.join(root, 'local-web-page.css'), 'utf8');
    const chatStyles = fs.readFileSync(path.join(root, 'local-web-chat.css'), 'utf8');
    const conversationStyles = fs.readFileSync(path.join(root, 'local-web-conversations.css'), 'utf8');
    const conversationScript = fs.readFileSync(path.join(root, 'local-web-conversation-ui.js'), 'utf8');
    const adapter = fs.readFileSync(path.join(root, 'local-web.ts'), 'utf8');

    expect(html).toContain('href="/local-web-page.css"');
    expect(shellStyles).toContain("@import url('/local-web-chat.css');");
    expect(shellStyles).toContain("@import url('/local-web-conversations.css');");
    expect(adapter).toContain("'/local-web-chat.css'");
    expect(adapter).toContain("'/local-web-conversation-ui.js'");
    expect(html).toContain('type="module"');
    expect(script).toContain("activityLabel.textContent = 'Still working'");
    expect(script).toContain('This page is local to this machine');
    expect(script).not.toContain('Nothing you type leaves');
    expect(script).not.toContain('No reply yet');
    expect(chatStyles).toContain('z-index: 3');
    expect(shellStyles).toContain('env(safe-area-inset-bottom)');
    expect(conversationStyles).toContain('prefers-reduced-transparency');
    expect(conversationStyles).toContain('prefers-contrast');
    expect(conversationScript).toContain('nanoclaw-local-web-history:');
    expect(conversationScript).toContain("Object.hasOwn(input, 'model')");
    expect(conversationScript).toContain("Object.hasOwn(input, 'effort')");
    expect(script).toContain("event.key === 'Escape'");
    expect(script).toContain('createAgentButton.focus()');
    expect(script).toContain("modelInput.value = providerWasChanged ? '' : selected?.model || ''");
    expect(script).toContain('model: modelInput.value.trim()');
    expect(script).toContain('effort: effortSelect.value');
    expect(script).toContain('agentSidebar.inert = drawerIsClosed');
    expect(script).toContain('sidebarScrim.hidden = !drawerOpen');
    expect(script).toContain("mobileSidebar.addEventListener('change'");
    expect(script).toContain('pnpm local-web');
  });
});
