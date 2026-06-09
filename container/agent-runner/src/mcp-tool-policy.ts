export const DISABLE_SEND_MESSAGE_ENV = 'NANOCLAW_DISABLE_SEND_MESSAGE';

export function shouldRegisterSendMessage(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[DISABLE_SEND_MESSAGE_ENV] !== '1';
}

export function buildSendMessageToolEnv(isScheduledTask?: boolean): Record<string, string> {
  return isScheduledTask ? {} : { [DISABLE_SEND_MESSAGE_ENV]: '1' };
}
