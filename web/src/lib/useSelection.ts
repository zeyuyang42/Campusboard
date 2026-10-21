import { useCallback, useEffect, useRef, useState } from "react";

/** Click / Cmd-click / Shift-click selection over an ordered list of ids. */
export function useSelection(ids: number[]) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const anchor = useRef<number | null>(null);
  const idsRef = useRef(ids);
  idsRef.current = ids;

  // Drop ids that no longer exist (`ids` should be memoised by the caller, so this runs on real changes).
  useEffect(() => {
    setSelected((prev) => {
      if (!prev.size) return prev;
      const live = new Set(ids);
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [ids]);

  const onRowMouseDown = useCallback((e: React.MouseEvent, id: number, index: number) => {
    if (e.button !== 0 && !(e.button === 2 && !selected.has(id))) return;
    if (e.shiftKey && anchor.current !== null) {
      const a = idsRef.current.indexOf(anchor.current as number);
      const [lo, hi] = a < index ? [a, index] : [index, a];
      setSelected(new Set(idsRef.current.slice(Math.max(0, lo), hi + 1)));
    } else if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
      anchor.current = id;
    } else {
      setSelected(new Set([id]));
      anchor.current = id;
    }
  }, [selected]);

  const clear = useCallback(() => setSelected(new Set()), []);
  const selectAll = useCallback(() => setSelected(new Set(idsRef.current)), []);
  return { selected, isSelected: (id: number) => selected.has(id), onRowMouseDown, clear, selectAll };
}
