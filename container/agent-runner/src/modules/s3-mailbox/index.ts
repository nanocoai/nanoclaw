import { registerAgentMailbox } from '../../mailbox/index.js';
import { loadS3MailboxConfig } from './config.js';
import { S3AgentMailbox } from './store.js';

registerAgentMailbox(() => new S3AgentMailbox(loadS3MailboxConfig()));

export { S3AgentMailbox } from './store.js';
