// A candidate module small enough to read whole, with one real guard in it. The protected matrix's mutation
// rewrites the comparison below; the control test is what has to notice.
export const allowsHead = (head, expected) => head === expected && typeof head === 'string' && head.length === 40;
