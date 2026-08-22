import { releaseLock } from './guard';

/** Runs once after the whole suite; releases the machine-wide lock taken in global setup. */
export default async function globalTeardown(): Promise<void> {
  releaseLock();
}
