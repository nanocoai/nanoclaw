---
name: whatsapp-pairing-code
description: Add phone number pairing code authentication for WhatsApp as an alternative to QR code scanning. Use when the user needs pairing code authentication, can't scan QR codes (headless server, accessibility needs, remote SSH), or prefers manual code entry. Triggers on "pairing code", "phone number auth", "whatsapp phone", "can't scan qr", or "manual authentication".
---

# WhatsApp Pairing Code Authentication

Adds phone number pairing code authentication to NanoClaw's WhatsApp setup as an alternative to QR code scanning.

**What this changes:**
- Authentication methods: QR code only → QR code (default) or Pairing code (optional)
- `src/whatsapp-auth.ts`: Adds phone number input and pairing code logic
- `.claude/skills/setup/SKILL.md`: Adds authentication method selection step

**What stays the same:**
- Default behavior: QR code (backward compatible)
- Credential storage format and location
- Main application authentication flow
- Reconnection and session handling

**When to use:**
- Headless servers without display
- Remote SSH sessions
- Screen reader users (accessibility)
- Environments where camera scanning isn't available
- Preference for manual code entry

---

## Step 1: Update whatsapp-auth.ts

### 1a. Update the file header comment

Edit `src/whatsapp-auth.ts` around lines 2-8:

```typescript
// Before:
 * WhatsApp Authentication Script
 *
 * Run this during setup to authenticate with WhatsApp.
 * Displays QR code, waits for scan, saves credentials, then exits.
 *
 * Usage: npx tsx src/whatsapp-auth.ts

// After:
 * WhatsApp Authentication Script
 *
 * Run this during setup to authenticate with WhatsApp.
 * Supports two modes:
 *   - QR code (default): npx tsx src/whatsapp-auth.ts
 *   - Pairing code:      npx tsx src/whatsapp-auth.ts --phone 821012345678
 *
 * Phone number must be in E.164 format without the '+' sign.
```

### 1b. Add readline import

Add to the imports section (around line 11):

```typescript
import readline from 'readline';
```

### 1c. Add parseArgs function

Add this function after the logger initialization (around line 28):

```typescript
function parseArgs(): { phone?: string } {
  const args = process.argv.slice(2);
  const phoneIdx = args.indexOf('--phone');
  if (phoneIdx !== -1 && args[phoneIdx + 1]) {
    return { phone: args[phoneIdx + 1].replace(/[^0-9]/g, '') };
  }
  return {};
}
```

### 1d. Add askPhone function

Add this function after parseArgs:

```typescript
function askPhone(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('Enter phone number (E.164, no +, e.g. 821012345678): ', (answer) => {
      rl.close();
      resolve(answer.replace(/[^0-9]/g, ''));
    });
  });
}
```

### 1e. Update authenticate function

Replace the authenticate function body (starting around line 48). The new logic should:

1. Check for `--phone` argument or flag
2. Ask for phone number interactively if `--phone` is present but empty
3. Log which authentication mode is being used
4. Wrap socket creation in `startSocket()` function for proper reconnection

Here's the complete replacement:

```typescript
async function authenticate(): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  if (state.creds.registered) {
    console.log('✓ Already authenticated with WhatsApp');
    console.log(
      '  To re-authenticate, delete the store/auth folder and run again.',
    );
    process.exit(0);
  }

  const { phone: argPhone } = parseArgs();
  const usePairingCode = argPhone !== undefined || process.argv.includes('--phone');
  let phoneNumber = argPhone;

  if (usePairingCode && !phoneNumber) {
    phoneNumber = await askPhone();
  }

  if (usePairingCode) {
    console.log(`Starting WhatsApp authentication via pairing code for ${phoneNumber}...\n`);
  } else {
    console.log('Starting WhatsApp authentication via QR code...\n');
  }

  async function startSocket(): Promise<void> {
    const { state: currentState, saveCreds: saveCurrentCreds } =
      await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({
      auth: {
        creds: currentState.creds,
        keys: makeCacheableSignalKeyStore(currentState.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: ['NanoClaw', 'Chrome', '1.0.0'],
    });

    let pairingCodeRequested = false;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Pairing code: only request when QR is available (socket is ready)
      if (usePairingCode && !pairingCodeRequested && qr) {
        pairingCodeRequested = true;
        try {
          const code = await sock.requestPairingCode(phoneNumber!);
          console.log(`\n╔══════════════════════════════════╗`);
          console.log(`║   Pairing Code:  ${code}        ║`);
          console.log(`╚══════════════════════════════════╝\n`);
          console.log('On your phone:');
          console.log('  1. Open WhatsApp');
          console.log('  2. Settings → Linked Devices → Link a Device');
          console.log('  3. Tap "Link with phone number instead"');
          console.log(`  4. Enter the code: ${code}\n`);
        } catch (err: any) {
          console.error('Failed to request pairing code:', err.message);
          console.log('Retrying...');
          pairingCodeRequested = false;
        }
      } else if (!usePairingCode && qr) {
        console.log('Scan this QR code with WhatsApp:\n');
        console.log('  1. Open WhatsApp on your phone');
        console.log('  2. Tap Settings → Linked Devices → Link a Device');
        console.log('  3. Point your camera at the QR code below\n');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        const reason = (lastDisconnect?.error as any)?.output?.statusCode;

        if (reason === DisconnectReason.loggedOut) {
          console.log('\n✗ Logged out. Delete store/auth and try again.');
          process.exit(1);
        } else {
          console.log(`  Reconnecting (reason: ${reason})...`);
          setTimeout(() => startSocket(), 2000);
        }
      }

      if (connection === 'open') {
        console.log('\n✓ Successfully authenticated with WhatsApp!');
        console.log('  Credentials saved to store/auth/');
        console.log('  You can now start the NanoClaw service.\n');

        setTimeout(() => process.exit(0), 1000);
      }
    });

    sock.ev.on('creds.update', saveCurrentCreds);
  }

  await startSocket();
}
```

**Key changes:**
- Added `parseArgs()` and `askPhone()` for phone number input
- Added `usePairingCode` flag to determine authentication mode
- Wrapped socket creation in `startSocket()` for proper reconnection
- Added pairing code request logic with error handling
- Kept QR code logic unchanged for backward compatibility

---

## Step 2: Update setup skill

Edit `.claude/skills/setup/SKILL.md` to add authentication method selection.

### 2a. Update Section 5 header

Find the line (around line 140):

```markdown
## 5. WhatsApp Authentication
```

Replace the entire section up to "## 6. Configure Assistant Name" with:

```markdown
## 5. WhatsApp Authentication

**USER ACTION REQUIRED**

**Use the AskUserQuestion tool** to ask the user which authentication method they prefer:

> **Question:** Which WhatsApp authentication method would you like to use?
>
> Options:
> 1. **QR Code (Recommended)** - Quick visual scanning with your camera
> 2. **Pairing Code** - Enter an 8-digit code manually (useful if camera isn't available)

### Option 1: QR Code Authentication

**IMPORTANT:** Run this command in the **foreground**. The QR code is multi-line ASCII art that must be displayed in full. Do NOT run in background or truncate the output.

Tell the user:
> A QR code will appear below. On your phone:
> 1. Open WhatsApp
> 2. Tap **Settings → Linked Devices → Link a Device**
> 3. Scan the QR code

Run with a long Bash tool timeout (120000ms) so the user has time to scan. Do NOT use the `timeout` shell command (it's not available on macOS).

```bash
npm run auth
```

Wait for the script to output "Successfully authenticated" then continue.

If it says "Already authenticated", skip to the next step.

### Option 2: Pairing Code Authentication

Ask the user for their phone number:
> Enter your WhatsApp phone number with country code (no spaces or + sign).
>
> Examples:
> - US: 14155551234
> - UK: 447700900123
> - Korea: 821012345678

Then run with the phone number. Run with a long Bash tool timeout (120000ms). Do NOT use the `timeout` shell command (it's not available on macOS).

```bash
npm run auth -- --phone <PHONE_NUMBER>
```

Example:
```bash
npm run auth -- --phone 821012345678
```

Tell the user:
> An 8-digit pairing code will appear in a box. On your phone:
> 1. Open WhatsApp
> 2. Tap **Settings → Linked Devices → Link a Device**
> 3. Tap **"Link with phone number instead"**
> 4. Enter the 8-digit code shown in the terminal

Wait for the script to output "Successfully authenticated" then continue.

If it says "Already authenticated", skip to the next step.
```

---

## Step 3: Test the changes

### Test QR code method (backward compatibility)

```bash
npm run auth
```

**Expected:**
- Script starts with "Starting WhatsApp authentication via QR code..."
- QR code displays in terminal
- After scanning, shows "Successfully authenticated"

### Test pairing code with phone number argument

```bash
npm run auth -- --phone 821012345678
```

**Expected:**
- Script starts with "Starting WhatsApp authentication via pairing code for 821012345678..."
- 8-digit pairing code displays in a box (╔══╗ format)
- Instructions for manual entry
- After entering code on phone, shows "Successfully authenticated"

### Test pairing code with interactive prompt

```bash
npm run auth -- --phone
```

**Expected:**
- Prompts: "Enter phone number (E.164, no +, e.g. 821012345678):"
- After entering number, shows pairing code
- Authentication completes successfully

### Verify credentials

```bash
ls -la store/auth/
```

**Expected:**
- `creds.json` and other auth files present
- Files have correct permissions (readable by user)

---

## Troubleshooting

### "Failed to request pairing code"

**Causes:**
- Invalid phone number format (must be E.164: country code + number)
- Network connectivity issue
- WhatsApp rate limiting

**Fix:**
1. Verify phone number format: no spaces, no +, starts with country code
2. Wait 1-2 minutes and try again
3. Try QR code method instead: `npm run auth`

### Pairing code not working on phone

**Causes:**
- Code expired (pairing codes are time-limited)
- Incorrect code entry
- WhatsApp app needs update

**Fix:**
1. Check for new code in terminal (script may have generated a new one)
2. Ensure you tapped "Link with phone number instead" not just "Link a Device"
3. Update WhatsApp to latest version
4. Try QR code method instead

### Already authenticated but want to re-authenticate

```bash
rm -rf store/auth/
npm run auth -- --phone <PHONE_NUMBER>
```

---

## Notes

- **Default behavior unchanged**: `npm run auth` still uses QR code
- **E.164 format**: Country code + number, no spaces or + sign (e.g., 14155551234)
- **Both methods available**: Users can choose based on their needs
- **Backward compatible**: Existing installations and scripts work without changes
- **No new dependencies**: Uses built-in Node.js `readline` module
