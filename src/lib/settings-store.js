'use strict';

const fs = require('node:fs');
const path = require('node:path');

class JsonStore {
  constructor(filePath, defaults) {
    this.filePath = filePath;
    this.defaults = structuredClone(defaults);
    this.data = this.#read();
  }

  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return { ...structuredClone(this.defaults), ...parsed };
    } catch (_error) {
      return structuredClone(this.defaults);
    }
  }

  getAll() {
    return structuredClone(this.data);
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
    return value;
  }

  replace(nextData) {
    this.data = { ...structuredClone(this.defaults), ...structuredClone(nextData) };
    this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    try {
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch (_cleanupError) {
        // The original write error is more useful to the caller.
      }
      throw error;
    }
  }
}

module.exports = { JsonStore };
