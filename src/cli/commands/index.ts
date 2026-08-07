/**
 * Command barrel — populates the registry before the CLI server starts.
 *
 * Resource definitions register their CRUD commands on import.
 * Help commands are registered after resources are loaded.
 */
import '../resources/index.js';
import { registerResourceHelpCommands } from './help.js';

registerResourceHelpCommands();
