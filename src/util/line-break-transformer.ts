import { findSubarrayIndex } from "./find-subarray-index";

export class LineBreakTransformer implements Transformer<string, string> {
  private chunks = "";

  transform(
    chunk: string,
    controller: TransformStreamDefaultController<string>,
  ) {
    // Append new chunks to existing chunks.
    this.chunks += chunk;
    // For each line breaks in chunks, send the parsed lines out.
    const lines = this.chunks.split("\r\n");
    this.chunks = lines.pop()!;
    lines.forEach((line) => controller.enqueue(line + "\r\n"));
  }

  flush(controller: TransformStreamDefaultController<string>) {
    // When the stream is closed, flush any remaining chunks out.
    controller.enqueue(this.chunks);
  }
}

export class Uint8LineBreakTransformer implements Transformer<Uint8Array, Uint8Array> {
  private chunks = new Uint8Array();

  transform(
    chunk: Uint8Array,
    controller: TransformStreamDefaultController<Uint8Array>,
  ) {
    // Append new chunks to existing chunks.
    const newChunks = new Uint8Array(this.chunks.length + chunk.length);
    newChunks.set(this.chunks, 0);
    newChunks.set(chunk, this.chunks.length);
    this.chunks = newChunks;
    // For each line breaks in chunks, send the parsed lines out.
    let toModifyIndex = findSubarrayIndex(this.chunks, new Uint8Array([13, 10]));

    while (toModifyIndex !== undefined) {
      const beginning = this.chunks.slice(0, toModifyIndex);
      const end = this.chunks.slice(toModifyIndex + 2);

      this.chunks = new Uint8Array(this.chunks.length - 1);

      this.chunks.set(beginning, 0);
      this.chunks.set([10], beginning.length);
      this.chunks.set(end, beginning.length + 1);

      toModifyIndex = findSubarrayIndex(this.chunks, new Uint8Array([13, 10]), toModifyIndex - 1);
    }

    controller.enqueue(this.chunks);
    this.chunks = new Uint8Array();
  }

  flush(controller: TransformStreamDefaultController<Uint8Array>) {
    // When the stream is closed, flush any remaining chunks out.
    if (this.chunks.length > 0) {
      controller.enqueue(this.chunks);
    }
  }
}