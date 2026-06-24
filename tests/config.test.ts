import { describe, it, expect } from 'vitest';
import { expandHome } from '../src/config';

describe('expandHome', () => {
  const home = process.env.HOME ?? '';

  it('expands a leading ~/', () => {
    expect(expandHome('~/.cache/x')).toBe(`${home}/.cache/x`);
  });

  it('expands a bare ~', () => {
    expect(expandHome('~')).toBe(home);
  });

  it('leaves absolute paths untouched', () => {
    expect(expandHome('/opt/models')).toBe('/opt/models');
  });

  it('does not expand ~ that is not at the start', () => {
    expect(expandHome('/a/~/b')).toBe('/a/~/b');
  });
});
