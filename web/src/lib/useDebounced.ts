import { useEffect, useState } from "react";

/**
 * `value`, but only after it has stopped changing for `ms`. `key` decides what counts as a
 * change (default: the value itself); pass `JSON.stringify(value)` for an object built each render.
 */
export function useDebounced<T>(value: T, ms: number, key: unknown = value): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ms]);
  return v;
}
