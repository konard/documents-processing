// evisa-passport-worker.mjs
//
// Reads a passport photo on a worker thread, for readPassportDocumentInWorker
// in evisa-session. The OCR engine runs synchronously and takes seconds per
// page; here it stalls nothing but this thread.

import { parentPort, workerData } from 'node:worker_threads';
import { readPassportDocument } from './evisa-session.mjs';

readPassportDocument(workerData.inputPath, workerData.outputPath).then(
  (result) => parentPort.postMessage({ ok: true, result }),
  (error) => parentPort.postMessage({ ok: false, error: error.message })
);
