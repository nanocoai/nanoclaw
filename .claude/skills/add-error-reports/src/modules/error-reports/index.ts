/**
 * Error reports: forwards the host's operational errors to one chat.
 * Inert unless ERROR_REPORTS_MESSAGING_GROUP is set in .env.
 */
import { onDeliveryAdapterReady } from '../../delivery.js';
import { registerOperationalErrorSink } from '../../operational-errors.js';
import { createErrorReporter, readErrorReportConfig } from './reporter.js';

const config = readErrorReportConfig();
if (config) {
  const reporter = createErrorReporter(config);
  registerOperationalErrorSink(reporter.report);
  onDeliveryAdapterReady(reporter.attach);
}
