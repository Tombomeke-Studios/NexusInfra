import { Writable } from 'stream';

/**
 * A Writable that buffers incoming bytes and invokes `onLine` once per complete
 * line (newline-delimited). Trailing CRs are stripped; a final partial line is
 * flushed on stream end. Used to turn a container's (demuxed) log stream into
 * discrete lines for SSE.
 */
export function lineSplitter(onLine: (line: string) => void): Writable {
  let buf = '';
  return new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line.length) onLine(line);
      }
      cb();
    },
    final(cb) {
      const line = buf.replace(/\r$/, '');
      if (line.length) onLine(line);
      buf = '';
      cb();
    },
  });
}
