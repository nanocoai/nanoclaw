// Provider runtime-contract barrel.
// Each import attaches a provider's runtime contract to its registration via
// registerProviderContract() at top level (order-independent with the
// providers barrel). Skills add a new provider's contract by appending one
// import line below, next to the line they add in providers/index.ts.
// The test-double `mock` provider is not in either production barrel; its
// contract (./mock.ts) is imported by the tests that register the mock.

import './claude.js';
