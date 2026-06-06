// 统一注册所有命令（side-effect imports）
import './session.js';
import './account.js';
import './misc.js';
import './remote-control.js';
import './quiet.js';
import './brief.js';
import './mode.js';
import './topic-brief.js';
import './alias.js';

export { dispatch, getHelp, getRegisteredCommands } from './registry.js';
export type { Command, CommandContext } from './types.js';
