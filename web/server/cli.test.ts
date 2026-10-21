import { describe, expect, it } from 'vitest';
import { parseArgs } from './cli';

describe('host browser origins on the CLI', () => {
  it('keeps the legacy same-origin-only default', () => {
    expect(parseArgs([], {})).toMatchObject({ allowedOrigins: [], bind: null, port: 8787 });
  });

  it('accepts repeatable explicit origins and removes duplicates', () => {
    const args = parseArgs(['--allow-origin', 'https://elmorei.github.io', '--allow-origin=https://friends.example', '--allow-origin', 'https://elmorei.github.io'], {});
    expect(args.allowedOrigins).toEqual(['https://elmorei.github.io', 'https://friends.example']);
  });

  it('reads comma-separated origins from the environment unless explicitly overridden', () => {
    const env = { FLAGHACK_ALLOWED_ORIGINS: 'https://elmorei.github.io, https://friends.example' };
    expect(parseArgs([], env).allowedOrigins).toEqual(['https://elmorei.github.io', 'https://friends.example']);
    expect(parseArgs(['--allow-origin', 'https://private.example'], env).allowedOrigins).toEqual(['https://private.example']);
  });

  it.each(['*', 'https://*.example', 'null', 'file://local', 'https://elmorei.github.io/FLAGHACK/', 'https://user:password@example.com'])('rejects unsafe or non-origin values: %s', (origin) => {
    expect(() => parseArgs(['--allow-origin', origin], {})).toThrow(/origin/i);
  });

  it('keeps existing password, port, name and bind parsing', () => {
    expect(parseArgs(['--password=pw', '--port', '1234', '--name', 'Test', '--bind', '127.0.0.1'], {})).toEqual({
      help: false, password: 'pw', port: 1234, name: 'Test', bind: '127.0.0.1', allowedOrigins: [],
    });
  });
});
