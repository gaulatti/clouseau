// Load every production module so new, untested files cannot disappear from coverage.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
async function load(directory) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await load(filename);
    else if (/\.(cjs|mjs|js)$/.test(entry.name) && !/\.(test|spec)\.(cjs|mjs|js)$/.test(entry.name)) {
      await import(pathToFileURL(filename));
    }
  }
}
await load(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src'));
