import { decodeTime, isValid, monotonicFactory } from 'ulid';

// Every row ID is a ULID (SPEC, Data models): sortable by creation time and
// safe in URLs. The monotonic factory keeps IDs ordered within a millisecond.
const nextUlid = monotonicFactory();

export function newId(): string {
  return nextUlid();
}

export function isId(value: string): boolean {
  return isValid(value);
}

/** When an ID was created. */
export function idTime(id: string): Date {
  return new Date(decodeTime(id));
}
