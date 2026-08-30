// Provider self-registration barrel.
// Each import triggers the provider module's registerProvider() call at top
// level. Skills add a new provider by appending one import line below.

import './claude.js';
// Children run with DEFAULT_AGENT_PROVIDER=mock (credential-free); upstream
// leaves MockProvider unregistered. Registration rides its module import.
import './mock.js';
