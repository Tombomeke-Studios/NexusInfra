import { describe, it, expect } from 'vitest';
import { sftpUrl, sftpUsernameFor } from './sftp';

describe('sftp connection details (#235)', () => {
  it('names the account and the first eight characters of the server', () => {
    expect(sftpUsernameFor('ada@example.com', '1a2b3c4d-0000-4000-8000-000000000000')).toBe('ada@example.com.1a2b3c4d');
  });

  it('escapes the @ in the user name so the link parses', () => {
    expect(sftpUrl('ada@example.com.1a2b3c4d', 'panel.example.com', 2022)).toBe('sftp://ada%40example.com.1a2b3c4d@panel.example.com:2022');
  });

  it('leaves out the default port and brackets an IPv6 host', () => {
    expect(sftpUrl('u', 'panel.example.com', 22)).toBe('sftp://u@panel.example.com');
    expect(sftpUrl('u', '::1', 2022)).toBe('sftp://u@[::1]:2022');
  });
});
