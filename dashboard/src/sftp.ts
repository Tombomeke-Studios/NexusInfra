// How to reach one server over SFTP (#235). Mirrors `sftpUsernameFor` in the
// orchestrator's sftp.ts — the login name is `<email>.<first 8 of the server id>`.

export function sftpUsernameFor(email: string, deploymentId: string): string {
  return `${email}.${deploymentId.slice(0, 8)}`;
}

/** An `sftp://` link a file manager can open; the @ in the email must be escaped. */
export function sftpUrl(username: string, host: string, port: number): string {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `sftp://${encodeURIComponent(username)}@${h}${port === 22 ? '' : `:${port}`}`;
}
