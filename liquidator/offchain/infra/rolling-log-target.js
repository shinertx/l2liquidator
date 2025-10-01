'use strict';

const { Writable } = require('stream');
const {
  mkdirSync,
  createWriteStream,
  existsSync,
  renameSync,
  statSync,
  readdirSync,
  unlinkSync,
} = require('fs');
const { join, resolve } = require('path');

class RollingFileStream extends Writable {
  constructor(options = {}) {
    super();
    this.dir = resolve(process.cwd(), options.dir ?? 'logs');
    this.baseName = options.baseName ?? 'live.log';
    this.maxBytes = typeof options.maxBytes === 'number' && options.maxBytes > 0
      ? options.maxBytes
      : 20 * 1024 * 1024; // 20 MB default
    this.maxFiles = Number.isInteger(options.maxFiles) && options.maxFiles > 1
      ? options.maxFiles
      : 10; // archived files to keep in addition to active

    mkdirSync(this.dir, { recursive: true });
    this.currentPath = join(this.dir, this.baseName);
    this.stream = createWriteStream(this.currentPath, { flags: 'a' });
    this.currentSize = this._safeSize(this.currentPath);
  }

  _safeSize(path) {
    try {
      return statSync(path).size;
    } catch (err) {
      return 0;
    }
  }

  _write(chunk, encoding, callback) {
    const size = this._chunkSize(chunk, encoding);
    if (this.currentSize + size > this.maxBytes) {
      try {
        this._rotate();
      } catch (err) {
        callback(err);
        return;
      }
    }

    if (!this.stream.write(chunk, encoding)) {
      this.stream.once('drain', () => {
        this.currentSize += size;
        callback();
      });
      return;
    }

    this.currentSize += size;
    callback();
  }

  _chunkSize(chunk, encoding) {
    if (Buffer.isBuffer(chunk)) return chunk.length;
    const enc = encoding && encoding !== 'buffer' ? encoding : 'utf8';
    return Buffer.byteLength(String(chunk), enc);
  }

  _rotate() {
    if (this.stream) {
      this.stream.end();
    }

    if (existsSync(this.currentPath) && this.currentSize > 0) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const prefix = this.baseName.endsWith('.log')
        ? this.baseName.slice(0, -4)
        : this.baseName;
      const rotatedPath = join(this.dir, `${prefix}-${timestamp}.log`);
      try {
        renameSync(this.currentPath, rotatedPath);
      } catch (err) {
        // If rename fails, continue writing to avoid losing logs
        this.stream = createWriteStream(this.currentPath, { flags: 'a' });
        return;
      }
      this._trimArchives();
    }

    this.stream = createWriteStream(this.currentPath, { flags: 'a' });
    this.currentSize = this._safeSize(this.currentPath);
  }

  _trimArchives() {
    if (!this.maxFiles || this.maxFiles <= 1) return;

    const prefix = this.baseName.endsWith('.log')
      ? this.baseName.slice(0, -4)
      : this.baseName;

    const files = readdirSync(this.dir)
      .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith('.log'))
      .map((name) => ({
        name,
        mtime: this._safeMTime(join(this.dir, name)),
      }))
      .sort((a, b) => b.mtime - a.mtime);

    const retain = this.maxFiles - 1; // keep newest N archives; active file counts separately
    const excess = files.slice(retain);
    for (const file of excess) {
      try {
        unlinkSync(join(this.dir, file.name));
      } catch (err) {
        // ignore deletion errors
      }
    }
  }

  _safeMTime(path) {
    try {
      return statSync(path).mtimeMs;
    } catch (err) {
      return 0;
    }
  }

  _final(callback) {
    if (this.stream) {
      this.stream.end(() => callback());
      return;
    }
    callback();
  }
}

module.exports = function rollingFileTransport(options) {
  return new RollingFileStream(options);
};
