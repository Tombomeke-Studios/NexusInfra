import { Navigate, Outlet } from 'react-router-dom';
import { isAuthenticated } from '../session';

// Route guard: renders the nested routes only when a token is present,
// otherwise redirects to the login page.
export function RequireAuth() {
  return isAuthenticated() ? <Outlet /> : <Navigate to="/login" replace />;
}
