import { describe, it, expect, vi } from 'vitest';

describe('Config', () => {
  it('loads config from default path', async () => {
    // Reset module cache to ensure fresh load
    vi.resetModules();

    const { loadConfig } = await import('../config.js');
    const config = loadConfig();
    expect(config).toBeDefined();
    expect(typeof config.feishuAppId).toBe('string');
    expect(typeof config.defaultWorkingDirectory).toBe('string');
    expect(config.claude).toBeDefined();
    expect(typeof config.claude.model).toBe('string');
    expect(config.log).toBeDefined();
    expect(typeof config.log.level).toBe('string');
    expect(typeof config.healthPort).toBe('number');
  });

  it('returns cached config on second call', async () => {
    vi.resetModules();
    const { loadConfig } = await import('../config.js');
    const a = loadConfig();
    const b = loadConfig();
    expect(a).toBe(b);
  });
});
