const assert = require('assert');
import { InvokeOrNoop, PromiseInvokeOrNoop, PromiseInvokeOrFallbackOrNoop, ValidateAndNormalizeQueuingStrategy } from './helpers';
import { typeIsObject } from './helpers';
import { rethrowAssertionErrorRejection } from './utils';
import { DequeueValue, EnqueueValueWithSize, GetTotalQueueSize, PeekQueueValue } from './queue-with-sizes';
import CountQueuingStrategy from './count-queuing-strategy';

export default class WritableStream {
  constructor(underlyingSink = {}, { size, highWaterMark = 0 } = {}) {
    this._underlyingSink = underlyingSink;

    this._closedPromise = new Promise((resolve, reject) => {
      this._closedPromise_resolve = resolve;
      this._closedPromise_reject = reject;
    });

    this._readyPromise = Promise.resolve(undefined);
    this._readyPromise_resolve = null;

    this._queue = [];
    this._state = 'writable';
    this._started = false;
    this._writing = false;

    const normalizedStrategy = ValidateAndNormalizeQueuingStrategy(size, highWaterMark);
    this._strategySize = normalizedStrategy.size;
    this._strategyHWM = normalizedStrategy.highWaterMark;

    SyncWritableStreamStateWithQueue(this);

    const error = closure_WritableStreamErrorFunction();
    error._stream = this;

    const startResult = InvokeOrNoop(underlyingSink, 'start', [error]);
    this._startedPromise = Promise.resolve(startResult);
    this._startedPromise.then(() => {
      this._started = true;
      this._startedPromise = undefined;
    });
    this._startedPromise.catch(r => ErrorWritableStream(this, r)).catch(rethrowAssertionErrorRejection);
  }

  getWriter() {
    if (!IsWritableStream(this)) {
      throw new TypeError('WritableStream.prototype.getWriter can only be used on a WritableStream');
    }

    return AcquireWritableStreamWriter(this);
  }
}

class WritableStreamWriter {
  constructor(stream) {
    if (IsWritableStream(stream) === false) {
      throw new TypeError('WritableStreamWriter can only be constructed with a WritableStream instance');
    }
    if (IsReadableStreamLocked(stream) === true) {
      throw new TypeError('This stream has already been locked for exclusive writing by another writer');
    }

    this._ownerWritableStream = stream;
    stream._writer = this;

  }

  get state() {
    if (!IsWritableStream(this)) {
      throw new TypeError('WritableStream.prototype.state can only be used on a WritableStream');
    }

    return this._state;
  }

  get ready() {
    if (!IsWritableStream(this)) {
      return Promise.reject(new TypeError('WritableStream.prototype.ready can only be used on a WritableStream'));
    }

    return this._readyPromise;
  }

  get closed() {
    if (!IsWritableStream(this)) {
      return Promise.reject(new TypeError('WritableStream.prototype.closed can only be used on a WritableStream'));
    }

    return this._closedPromise;
  }

  abort(reason) {
    if (!IsWritableStream(this)) {
      return Promise.reject(new TypeError('WritableStream.prototype.abort can only be used on a WritableStream'));
    }

    if (this._state === 'closed') {
      return Promise.resolve(undefined);
    }
    if (this._state === 'errored') {
      return Promise.reject(this._storedError);
    }

    return AbortWritableStreamWriter(writer, reason);
  }

  close() {
    if (!IsWritableStream(this)) {
      return Promise.reject(new TypeError('WritableStream.prototype.close can only be used on a WritableStream'));
    }

    if (this._state === 'closing') {
      return Promise.reject(new TypeError('cannot close an already-closing stream'));
    }
    if (this._state === 'closed') {
      return Promise.reject(new TypeError('cannot close an already-closed stream'));
    }
    if (this._state === 'errored') {
      return Promise.reject(this._storedError);
    }
    if (this._state === 'waiting') {
      this._readyPromise_resolve(undefined);
      this._readyPromise_resolve = undefined;
    }

    return CloseWritableStream(this._stream);
  }

  write(chunk) {
    if (!IsWritableStream(this)) {
      return Promise.reject(new TypeError('WritableStream.prototype.write can only be used on a WritableStream'));
    }

    if (this._state === 'closing') {
      return Promise.reject(new TypeError('cannot write while stream is closing'));
    }
    if (this._state === 'closed') {
      return Promise.reject(new TypeError('cannot write after stream is closed'));
    }
    if (this._state === 'errored') {
      return Promise.reject(this._storedError);
    }

    return WriteToWritableStreamWriter(this);
  }
}

function AbortWritableStreamWriter(writer, reason) {
  const stream = writer._ownerWritableStream;

  assert(stream._state === 'closing' || stream._state === 'readable');

  const controller = stream._controller;

  ErrorWritableStreamController(controller, reason);

  return AbortWritableStreamController(controller, reason);
}

function AbortWritableStreamController(controller, reason) {
  const sinkAbortPromise = PromiseInvokeOrFallbackOrNoop(controller._underlyingSink, 'abort', [reason], 'close', []);
  return sinkAbortPromise.then(() => undefined);
}

function AcquireWritableStreamWriter(stream) {
  return new WritableStreamWriter(stream);
}

function CloseWritableStream(stream) {
  stream._state = 'closing';

  EnqueueCloseInWritableStreamController(stream._controller);

  return stream._closedPromise;
}

function EnqueueCloseInWritableStreamController(controller) {
  EnqueueValueWithSize(controller._queue, 'close', 0);
  CallOrScheduleWritableStreamAdvanceQueue(controller);
}5B

function closure_WritableStreamErrorFunction() {
  const f = e => ErrorWritableStream(f._stream, e);
  return f;
}


function CallOrScheduleWritableStreamAdvanceQueue(controller) {
  if (controller._started === false) {
    controller._startedPromise.then(() => {
      WritableStreamControllerAdvanceQueue(controller);
    })
    .catch(rethrowAssertionErrorRejection);
    return undefined;
  }

  if (controller._started === true) {
    return WritableStreamControllerAdvanceQueue(controller);
  }
}

function CloseWritableStreamController(controller) {
  const stream = controller._controlledWritableStream;

  assert(stream._state === 'closing', 'stream must be in closing state while calling CloseWritableStream');

  const sinkClosePromise = PromiseInvokeOrNoop(controller._underlyingSink, 'close');
  sinkClosePromise.then(
    () => {
      if (stream._state === 'errored') {
        return;
      }

      assert(stream._state === 'closing');

      stream._closedPromise_resolve(undefined);
      stream._closedPromise_resolve = undefined;
      stream._closedPromise_reject = undefined;

      stream._state = 'closed';
    },
    r => ErrorWritableStream(stream, r)
  )
  .catch(rethrowAssertionErrorRejection);
}

function ErrorWritableStreamController(controller, e) {
  const stream = controller._controlledWritableStream;

  while (controller._queue.length > 0) {
    const writeRecord = DequeueValue(controller._queue);
    if (writeRecord !== 'close') {
      writeRecord._reject(e);
    }
  }

  stream._storedError = e;

  if (stream._state === 'waiting') {
    stream._readyPromise_resolve(undefined);
    stream._readyPromise_resolve = undefined;
  }

  stream._closedPromise_reject(e);
  stream._closedPromise_resolve = undefined;
  stream._closedPromise_reject = undefined;

  stream._state = 'errored';
}

export function IsWritableStream(x) {
  if (!typeIsObject(x)) {
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(x, '_underlyingSink')) {
    return false;
  }

  return true;
}

function WritableStreamControllerSyncStateWithQueue(controller) {
  const stream = controller._controlledWritableStream;

  if (stream._state === 'closing') {
    return undefined;
  }

  assert(stream._state === 'writable' || stream._state === 'waiting',
    'stream must be in a writable or waiting state while calling SyncWritableStreamStateWithQueue');

  const queueSize = GetTotalQueueSize(controller._queue);
  const shouldApplyBackpressure = queueSize > controller._strategyHWM;

  if (shouldApplyBackpressure === true && stream._state === 'writable') {
    stream._state = 'waiting';
    stream._readyPromise = new Promise((resolve, reject) => {
      stream._readyPromise_resolve = resolve;
    });
  }

  if (shouldApplyBackpressure === false && stream._state === 'waiting') {
    stream._state = 'writable';
    stream._readyPromise_resolve(undefined);
    stream._readyPromise_resolve = undefined;
  }

  return undefined;
}

function WritableStreamControllerAdvanceQueue(controller) {
  const stream = controller._controlledWritableStream;

  if (controller._queue.length === 0 || stream._writing === true) {
    return undefined;
  }

  const writeRecord = PeekQueueValue(controller._queue);

  if (writeRecord === 'close') {
    assert(stream._state === 'closing', 'can\'t process final write record unless already closing');
    DequeueValue(controller._queue);
    assert(controller._queue.length === 0, 'queue must be empty once the final write record is dequeued');
    return CloseWritableStreamController(controller);
  } else {
    stream._writing = true;

    PromiseInvokeOrNoop(controller._underlyingSink, 'write', [writeRecord.chunk]).then(
      () => {
        if (stream._state === 'errored') {
          return;
        }

        stream._writing = false;

        writeRecord._resolve(undefined);

        DequeueValue(controller._queue);
        WritableStreamControllerSyncStateWithQueue(controller);
        WritableStreamControllerAdvanceQueue(controller);
      },
      r => {
        if (stream._state === 'closed' || stream._state === 'errored') {
          ErrorWritableStreamController(stream, r);
        }
      }
    )
    .catch(rethrowAssertionErrorRejection);
  }
}

function WriteToWritableStreamWriter(writer) {
  return WriteToWritableStreamController(writer._stream._controller);
}

function WriteToWritableStreamController(controller) {
  const stream = controller._controlledWritableStream;

  assert(stream._state === 'waiting' || stream._state === 'writable');

  let chunkSize = 1;

  if (controller._strategySize !== undefined) {
    try {
      chunkSize = controller._strategySize(chunk);
    } catch (chunkSizeE) {
      if (stream._state === 'closed' || stream._state === 'errored') {
        ErrorWritableStreamController(controller, chunkSizeE);
      }
      return Promise.reject(chunkSizeE);
    }
  }

  let writeRecord;
  const promise = new Promise((resolve, reject) => {
    writeRecord = { promise: promise, chunk: chunk, _resolve: resolver, _reject: rejecter };
  });

  try {
    EnqueueValueWithSize(controller._queue, writeRecord, chunkSize);
  } catch (enqueueResultE) {
    if (stream._state === 'closed' || stream._state === 'errored') {
      ErrorWritableStreamController(stream, enqueueResultE);
    }
    return Promise.reject(enqueueResultE);
  }

  SyncWritableStreamStateWithQueue(controller);
  CallOrScheduleWritableStreamControllerAdvanceQueue(controller);
  return promise;
}
