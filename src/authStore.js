import fs from 'node:fs';
import path from 'node:path';

export function createAuthStore(filePath = path.resolve(process.cwd(), '.auth.json')) {
  function load() {
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function save(data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  function clear() {
    try { fs.unlinkSync(filePath); } catch {}
  }

  return { load, save, clear, filePath };
}
