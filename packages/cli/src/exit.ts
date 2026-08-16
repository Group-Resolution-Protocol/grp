/**
 * Spec 127 (TS4-1) — `process.exit()` discards stdio bytes still buffered in
 * the stream (a pipe accepts ~64 KiB synchronously; the rest waits in the
 * writable's internal buffer). A document-heavy `grp outcome --json` export
 * therefore truncated at exactly 65,536 bytes and still exited 0. Exit only
 * after both stdio streams have drained to the OS; if the reader never reads,
 * we block like any well-behaved process would.
 */
export function exitAfterFlush(code: number): void {
  const flush = (stream: NodeJS.WriteStream): Promise<void> =>
    new Promise((resolve) => {
      if (stream.writableLength === 0) {
        resolve();
        return;
      }
      stream.write("", () => resolve());
    });
  void Promise.all([flush(process.stdout), flush(process.stderr)]).then(() => process.exit(code));
}
