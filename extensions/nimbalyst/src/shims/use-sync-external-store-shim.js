// ESM stand-in for use-sync-external-store/shim: React 18+ has the hook built in. The CommonJS original calls
// require('react'), which the Nimbalyst panel runtime does not provide.
import { useSyncExternalStore } from 'react';
export { useSyncExternalStore };
export default { useSyncExternalStore };
