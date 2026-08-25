import { Routes, Route } from 'react-router-dom';
import { RequireAuth } from './components/RequireAuth';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { NewDeployment } from './pages/NewDeployment';
import { Servers } from './pages/Servers';
import { ServerDetail } from './pages/ServerDetail';
import { NodeDetail } from './pages/NodeDetail';
import { Teams } from './pages/Teams';
import { Preferences } from './pages/Preferences';
import { Billing } from './pages/Billing';
import { useEdition } from './edition';

// Route table: /login is public; everything else sits behind RequireAuth inside
// the app shell (Layout). Split from App so tests can mount it in a MemoryRouter.
export function AppRoutes() {
  const { isHosted } = useEdition();
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* Self-registration is a hosted-edition affordance (#174): on a
          self-hosted panel an administrator creates the accounts. */}
      {isHosted && <Route path="/register" element={<Login mode="register" />} />}
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route path="/" element={<Overview />} />
          <Route path="/new" element={<NewDeployment />} />
          <Route path="/servers" element={<Servers />} />
          <Route path="/servers/:id" element={<ServerDetail />} />
          <Route path="/nodes/:id" element={<NodeDetail />} />
          <Route path="/teams" element={<Teams />} />
          <Route path="/preferences" element={<Preferences />} />
          {/* Billing is hosted-edition only (#149). */}
          {isHosted && <Route path="/billing" element={<Billing />} />}
        </Route>
      </Route>
    </Routes>
  );
}
