"use client";

import { useEffect, useState } from "react";

/**
 * Debounce a value by `delay` milliseconds.
 * Returns the debounced value, which updates only after `delay` ms of inactivity.
 */
export function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);

  return debounced;
}
