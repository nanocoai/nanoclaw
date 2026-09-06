const sensitiveValues = new Set<string>();

export function registerSensitiveValue(value: string): void {
  if (value.length > 0) sensitiveValues.add(value);
}

export function redactSensitiveValues(value: string): string {
  let redacted = value;
  for (const secret of [...sensitiveValues].sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

export function createSensitiveRedactor(): { write(chunk: string): string; end(): string } {
  const secrets = [...sensitiveValues].sort((a, b) => b.length - a.length);
  const maxLength = Math.max(0, ...secrets.map((secret) => secret.length));
  let pending = '';

  const drain = (flush: boolean): string => {
    if (flush) {
      const output = redactSensitiveValues(pending);
      pending = '';
      return output;
    }
    const limit = pending.length - Math.max(0, maxLength - 1);
    let index = 0;
    let output = '';
    while (index < limit) {
      const secret = secrets.find((candidate) => pending.startsWith(candidate, index));
      if (secret) {
        output += '[REDACTED]';
        index += secret.length;
      } else {
        output += pending[index];
        index++;
      }
    }
    pending = pending.slice(index);
    return output;
  };

  return {
    write(chunk) {
      pending += chunk;
      return drain(false);
    },
    end() {
      return drain(true);
    },
  };
}

export function clearSensitiveValuesForTest(): void {
  sensitiveValues.clear();
}
