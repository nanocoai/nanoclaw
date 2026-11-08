// The send_card parts check, kept byte-identical in src/channels/ and container/agent-runner/src/mcp-tools/
// (host and container share no module); src/channels/card-parts.test.ts fails if the two differ.

/**
 * Per card, so every platform takes the whole card. The chart limits are what
 * Slack draws natively; past 10,000 characters Slack swaps a table for plain
 * text cut at 3,000; text and fields stay well under Slack's 3,000 and 2,000,
 * since its adapter adds markup after this check. 10 parts, 30 table rows and
 * 12,000 characters of text across the whole card keep the largest card well
 * inside the 100 KB a Teams bot message may hold, which Teams measures on the
 * JSON it receives, as UTF-16; and inside Slack's 50 blocks.
 */
const CARD_LIMITS = {
  parts: 10,
  fields: 10,
  tables: 1,
  tableRows: 30,
  tableColumns: 6,
  tableText: 10_000,
  charts: 2,
  chartPoints: 20,
  chartSeries: 12,
  title: 50,
  label: 20,
  text: 2_500,
  fieldText: 1_500,
  cardText: 12_000,
};

export type CardPart = Record<string, unknown> & { type: string };

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isLabel = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

/** Length as Teams receives it: JSON escapes quote marks, backslashes and control characters. */
const sizeInJson = (text: string) => JSON.stringify(text).length - 2;

/** A child with a type is a part; a text child keeps its old shape. */
export function isCardPart(child: unknown): child is CardPart {
  return isRecord(child) && typeof child.type === 'string' && typeof child.text !== 'string';
}

/**
 * Why the card can't be sent, each naming what to fix; empty when it can. Parts
 * are allowed by name, so none can carry a callback button.
 */
export function cardProblems(card: Record<string, unknown>): string[] {
  const children: unknown[] = Array.isArray(card.children) ? card.children : [];
  const actions: unknown[] = Array.isArray(card.actions) ? card.actions : [];
  const problems: string[] = [];
  const count = { parts: 0, fields: 0, tables: 0, charts: 0, text: 0 };
  const addText = (...texts: unknown[]) => {
    for (const text of texts) if (typeof text === 'string') count.text += sizeInJson(text);
  };
  addText(card.title, card.description);
  for (const action of actions) if (isRecord(action)) addText(action.label, action.url);
  children.forEach((child, i) => {
    if (!isCardPart(child)) return addText(isRecord(child) ? child.text : child);
    count.parts++;
    const at = `children[${i}]`;
    const fail = (why: string) => problems.push(`${at}: ${why}`);
    const props = isRecord(child.props) ? child.props : {};
    switch (child.type) {
      case 'Text': {
        if (!isLabel(props.content, CARD_LIMITS.text))
          fail(`props.content must be text of at most ${CARD_LIMITS.text} characters`);
        else addText(props.content);
        if (props.style !== undefined && !['plain', 'bold', 'muted'].includes(props.style as string)) {
          fail('props.style must be plain, bold or muted');
        }
        return;
      }
      case 'Fields': {
        const fields = Array.isArray(child.children) ? child.children : [];
        if (fields.length === 0) return fail('Fields needs at least one Field in children');
        count.fields += fields.length;
        fields.forEach((field, j) => {
          const where = `${at}.children[${j}]`;
          if (!isRecord(field) || field.type !== 'Field')
            return problems.push(`${where}: Fields holds only Field parts`);
          const fieldProps = isRecord(field.props) ? field.props : {};
          const value = Number.isFinite(fieldProps.value) ? String(fieldProps.value) : fieldProps.value;
          if (!isLabel(fieldProps.label, CARD_LIMITS.fieldText) || !isLabel(value, CARD_LIMITS.fieldText)) {
            return problems.push(`${where}: a Field needs props.label and props.value`);
          }
          if (fieldProps.label.length + value.length > CARD_LIMITS.fieldText)
            return problems.push(`${where}: at most ${CARD_LIMITS.fieldText} characters`);
          addText(fieldProps.label, value);
        });
        return;
      }
      case 'Table': {
        count.tables++;
        const { headers, rows, align, caption } = props;
        if (!Array.isArray(headers) || headers.length === 0 || !headers.every((h) => typeof h === 'string')) {
          return fail('props.headers must be a list of column names');
        }
        if (headers.length > CARD_LIMITS.tableColumns) return fail(`at most ${CARD_LIMITS.tableColumns} columns`);
        if (!Array.isArray(rows)) return fail('props.rows must be a list of rows');
        if (rows.length > CARD_LIMITS.tableRows) return fail(`at most ${CARD_LIMITS.tableRows} rows`);
        for (const [r, row] of rows.entries()) {
          if (!Array.isArray(row)) return fail(`row ${r} must be a list of cells`);
          if (row.length !== headers.length)
            return fail(`row ${r} has ${row.length} cells, expected ${headers.length}`);
          if (!row.every((cell) => typeof cell === 'string' || Number.isFinite(cell))) {
            return fail(`row ${r}: a cell must be text or a number`);
          }
        }
        const cells: string[] = [...headers, ...(rows as unknown[][]).flat().map(String)];
        if (cells.every((cell) => cell.trim().length === 0))
          return fail('the table has no text in its headers or cells');
        const aligns = ['left', 'center', 'right'];
        if (
          align !== undefined &&
          (!Array.isArray(align) || align.length > headers.length || !align.every((a) => aligns.includes(a as string)))
        ) {
          return fail('props.align must list left, center or right, one per column at most');
        }
        if (caption !== undefined && typeof caption !== 'string') return fail('props.caption must be text');
        const length = [...cells, caption ?? ''].join('').length;
        if (length > CARD_LIMITS.tableText) {
          return fail(`the table holds ${length} characters of text; at most ${CARD_LIMITS.tableText}`);
        }
        addText(...cells, caption);
        return;
      }
      case 'Chart': {
        count.charts++;
        const chart = isRecord(props.chart) ? props.chart : {};
        if (!isLabel(props.title, CARD_LIMITS.title))
          return fail(`props.title must be text of at most ${CARD_LIMITS.title} characters`);
        let labels: unknown[];
        if (chart.type === 'pie') {
          const segments = Array.isArray(chart.segments) ? chart.segments : [];
          if (segments.length === 0 || segments.length > CARD_LIMITS.chartSeries) {
            return fail(`props.chart.segments must list 1 to ${CARD_LIMITS.chartSeries} slices`);
          }
          const bad = segments.findIndex(
            (s) => !isRecord(s) || !Number.isFinite(s.value) || !((s.value as number) > 0),
          );
          if (bad !== -1) return fail(`props.chart.segments[${bad}].value must be a number above 0`);
          labels = segments.map((s) => (s as Record<string, unknown>).label);
          if (new Set(labels).size !== labels.length) return fail('slice labels must not repeat');
        } else if (chart.type === 'bar' || chart.type === 'line' || chart.type === 'area') {
          const { categories, series, xLabel, yLabel } = chart;
          if (!Array.isArray(categories) || categories.length === 0 || categories.length > CARD_LIMITS.chartPoints) {
            return fail(`props.chart.categories must list 1 to ${CARD_LIMITS.chartPoints} categories`);
          }
          if (!Array.isArray(series) || series.length === 0 || series.length > CARD_LIMITS.chartSeries) {
            return fail(`props.chart.series must list 1 to ${CARD_LIMITS.chartSeries} series`);
          }
          for (const s of series) {
            const values = isRecord(s) && Array.isArray(s.values) ? s.values : [];
            const name = isRecord(s) ? s.name : undefined;
            if (values.length !== categories.length) {
              return fail(`series "${String(name)}" has ${values.length} values, expected ${categories.length}`);
            }
            if (!values.every((v) => Number.isFinite(v)))
              return fail(`series "${String(name)}": values must be numbers`);
          }
          const names = series.map((s) => (s as Record<string, unknown>).name);
          if (new Set(categories).size !== categories.length || new Set(names).size !== names.length) {
            return fail('categories and series names must not repeat');
          }
          for (const axis of [xLabel, yLabel]) {
            if (axis !== undefined && !isLabel(axis, CARD_LIMITS.title)) {
              return fail(`axis labels must be text of at most ${CARD_LIMITS.title} characters`);
            }
          }
          addText(xLabel, yLabel);
          labels = [...categories, ...names];
        } else {
          return fail('props.chart.type must be pie, bar, line or area');
        }
        if (!labels.every((label) => isLabel(label, CARD_LIMITS.label))) {
          return fail(`each label must be text of at most ${CARD_LIMITS.label} characters`);
        }
        addText(props.title, ...labels);
        return;
      }
      case 'Divider':
        return;
      default:
        fail(`unknown part "${child.type}"; use Text, Fields, Table, Chart, Divider`);
    }
  });
  if (count.parts > CARD_LIMITS.parts) problems.push(`at most ${CARD_LIMITS.parts} parts per card`);
  if (count.fields > CARD_LIMITS.fields) problems.push(`at most ${CARD_LIMITS.fields} fields per card`);
  if (count.tables > CARD_LIMITS.tables) problems.push(`at most ${CARD_LIMITS.tables} Table per card`);
  if (count.charts > CARD_LIMITS.charts) problems.push(`at most ${CARD_LIMITS.charts} Charts per card`);
  if (count.text > CARD_LIMITS.cardText) {
    problems.push(
      `the card holds ${count.text} characters of text, with quote marks, backslashes, line breaks and control characters counting extra; at most ${CARD_LIMITS.cardText} per card`,
    );
  }
  return problems;
}
