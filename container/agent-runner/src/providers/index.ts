// Provider self-registration barrel.
// Each import triggers the provider module's registerProvider() call at top
// level. Skills add a new provider by appending one import line below.

import './claude.js';
import './codex.js';
import './mock.js';
