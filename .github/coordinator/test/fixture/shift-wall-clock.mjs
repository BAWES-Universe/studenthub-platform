// Test-only preload: advance JavaScript wall time while preserving ticking,
// explicit Date inputs, and native timers. Kernel file timestamps are unchanged.
const NativeDate = globalThis.Date;
const offset = Number(process.env.SHU_TEST_CLOCK_OFFSET_MS ?? 0);
if (!Number.isSafeInteger(offset)) throw new Error("SHU_TEST_CLOCK_OFFSET_MS must be an integer");
globalThis.Date = new Proxy(NativeDate, {
  construct(target, args, newTarget) { return Reflect.construct(target, args.length ? args : [NativeDate.now() + offset], newTarget); },
  apply() { return new NativeDate(NativeDate.now() + offset).toString(); },
  get(target, key, receiver) { return key === 'now' ? () => NativeDate.now() + offset : Reflect.get(target, key, receiver); },
});
