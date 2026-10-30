// ESM port of use-sync-external-store/shim/with-selector (MIT, Meta Platforms), built on React's own
// useSyncExternalStore. The CommonJS original calls require('react'), which the Nimbalyst panel runtime does not provide.
import { useDebugValue, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

export function useSyncExternalStoreWithSelector(subscribe, getSnapshot, getServerSnapshot, selector, isEqual) {
  const instance = useRef(null);
  if (instance.current === null) instance.current = { hasValue: false, value: null };
  const inst = instance.current;
  const [getSelection, getServerSelection] = useMemo(() => {
    let hasMemo = false, memoizedSnapshot, memoizedSelection;
    const memoizedSelector = nextSnapshot => {
      if (!hasMemo) {
        hasMemo = true; memoizedSnapshot = nextSnapshot;
        const nextSelection = selector(nextSnapshot);
        if (isEqual !== undefined && inst.hasValue && isEqual(inst.value, nextSelection)) { memoizedSelection = inst.value; return inst.value; }
        memoizedSelection = nextSelection; return nextSelection;
      }
      if (Object.is(memoizedSnapshot, nextSnapshot)) return memoizedSelection;
      const nextSelection = selector(nextSnapshot);
      if (isEqual !== undefined && isEqual(memoizedSelection, nextSelection)) { memoizedSnapshot = nextSnapshot; return memoizedSelection; }
      memoizedSnapshot = nextSnapshot; memoizedSelection = nextSelection; return nextSelection;
    };
    return [() => memoizedSelector(getSnapshot()), getServerSnapshot == null ? undefined : () => memoizedSelector(getServerSnapshot())];
  }, [getSnapshot, getServerSnapshot, selector, isEqual]);
  const value = useSyncExternalStore(subscribe, getSelection, getServerSelection);
  useEffect(() => { inst.hasValue = true; inst.value = value; }, [value]);
  useDebugValue(value);
  return value;
}

export default { useSyncExternalStoreWithSelector };
