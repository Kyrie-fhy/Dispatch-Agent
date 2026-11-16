let sequence = 0;

export function newId(): string {
  return `order-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2, 8)}`;
}
