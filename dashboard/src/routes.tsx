import { Routes, Route } from 'react-router-dom';
import { RequireAuth } from './components/RequireAuth';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { NewDeployment } from './pages/NewDeployment';
import { Servers } from './pages/Servers';
import { ServerDetail } from './pages/ServerDetail';
import { Preferences } from './pages/Preferences';

// Route table: /login is public; everything else sits behind RequireAuth inside
// the app shell (Layout). Split from App so tests can mount it in a MemoryRouter.
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route path="/" element={<Overview />} />
          <Route path="/new" element={<NewDeployment />} />
          <Route path="/servers" element={<Servers />} />
          <Route path="/servers/:id" element={<ServerDetail />} />
          <Route path="/preferences" element={<Preferences />} />
        </Route>
      </Route>
    </Routes>
  );
}
