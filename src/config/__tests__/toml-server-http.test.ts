/**
 * Tests for the [server.http] TOML block parsing + default resolution.
 */

import { describe, it, expect } from 'vitest';
import { parseTomlConfig } from '../toml-loader.js';

const MIN_SOURCE = `
[[sources]]
id = "h1"
host = "h1.example"
user = "u"
auth = "kerberos"
`;

describe('parseTomlConfig — [server.http]', () => {
  it('accepts the block with full options and projects to ResolvedConfig.server.http', () => {
    const toml = `${MIN_SOURCE}
[server.http]
enabled = true
bind = "127.0.0.1"
port = 8934
auth_token_env = "SSH_MCP_HTTP_TOKEN"
origin_allowlist = ["http://127.0.0.1", "http://localhost"]
allowed_hosts = ["127.0.0.1:8934", "localhost:8934"]
request_timeout_ms = 30000
`;
    const cfg = parseTomlConfig(toml);
    expect(cfg.server?.http).toEqual({
      enabled: true,
      bind: '127.0.0.1',
      port: 8934,
      auth_token_env: 'SSH_MCP_HTTP_TOKEN',
      origin_allowlist: ['http://127.0.0.1', 'http://localhost'],
      allowed_hosts: ['127.0.0.1:8934', 'localhost:8934'],
      request_timeout_ms: 30000,
    });
  });

  it('rejects non-integer port', () => {
    const toml = `${MIN_SOURCE}
[server.http]
port = 8000.5
`;
    expect(() => parseTomlConfig(toml)).toThrow(/port must be an integer/);
  });

  it('rejects out-of-range port', () => {
    const toml = `${MIN_SOURCE}
[server.http]
port = 70000
`;
    expect(() => parseTomlConfig(toml)).toThrow(/port must be an integer/);
  });

  it('rejects enabled = "true" (string)', () => {
    const toml = `${MIN_SOURCE}
[server.http]
enabled = "true"
`;
    expect(() => parseTomlConfig(toml)).toThrow(/enabled must be a boolean/);
  });

  it('rejects non-array origin_allowlist', () => {
    const toml = `${MIN_SOURCE}
[server.http]
origin_allowlist = "http://localhost"
`;
    expect(() => parseTomlConfig(toml)).toThrow(/origin_allowlist must be an array/);
  });

  it('rejects empty auth_token_env', () => {
    const toml = `${MIN_SOURCE}
[server.http]
auth_token_env = ""
`;
    expect(() => parseTomlConfig(toml)).toThrow(/auth_token_env/);
  });

  it('leaves http undefined when section absent', () => {
    const cfg = parseTomlConfig(MIN_SOURCE);
    expect(cfg.server?.http).toBeUndefined();
  });
});
