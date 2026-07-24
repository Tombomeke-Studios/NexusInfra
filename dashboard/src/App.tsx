import { useEffect } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { AppRoutes } from './routes';
import { ToastProvider } from './components/Toast';
import { AuroraBackground } from './components/AuroraBackground';
import { initInteractionFx } from './fx';

export function App() {
  useEffect(() => initInteractionFx(), []);

  return (
    <ToastProvider>
      <BrowserRouter>
        <AuroraBackground />
        <div className="app-content">
          <AppRoutes />
        </div>
      </BrowserRouter>
    </ToastProvider>
  );
}
