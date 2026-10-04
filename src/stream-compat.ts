// WebKit in older supported macOS releases provides streams without async
// iteration. PDF.js reads text content with `for await`, including its legacy
// build, so retain the native stream and adapt only the missing iterator.
if (typeof ReadableStream !== 'undefined' && typeof Reflect.get(ReadableStream.prototype, Symbol.asyncIterator) !== 'function') {
  Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, {
    configurable: true,
    writable: true,
    value: async function* <T>(this: ReadableStream<T>, options: { preventCancel?: boolean } = {}) {
      const reader = this.getReader();
      let finished = false;
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) { finished = true; return; }
          yield result.value;
        }
      } finally {
        try { if (!finished && !options.preventCancel) await reader.cancel(); }
        finally { reader.releaseLock(); }
      }
    },
  });
}

export {};
