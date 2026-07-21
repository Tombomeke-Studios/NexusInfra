import { TOKEN_KEY, getToken } from './api';

// Session helpers around the stored JWT. The token itself is read/written via
// this module so the rest of the app never touches localStorage directly.

export function isAuthenticated(): boolean {
  return !!getToken();
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function logout(): void {
  localStorage.removeItem(TOKEN_KEY);
}
