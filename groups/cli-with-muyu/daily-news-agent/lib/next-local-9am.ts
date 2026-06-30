const DEFAULT_TIMEZONE = 'Asia/Shanghai';

function wallClockParts(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parseInt(parts.find((p) => p.type === type)!.value, 10);

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function addCalendarDays(year: number, month: number, day: number, days: number) {
  const dt = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth() + 1,
    day: dt.getUTCDate(),
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Next local 09:00 in `timeZone`, as naive ISO (no Z suffix). */
export function nextLocal9am(now: Date, timeZone = DEFAULT_TIMEZONE): string {
  const wall = wallClockParts(now, timeZone);
  const pastNine =
    wall.hour > 9 || (wall.hour === 9 && (wall.minute > 0 || wall.second > 0));

  let { year, month, day } = wall;
  if (pastNine) {
    ({ year, month, day } = addCalendarDays(year, month, day, 1));
  }

  return `${year}-${pad2(month)}-${pad2(day)}T09:00:00`;
}
