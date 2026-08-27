import { useEffect } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { AppRoutes } from './routes';
import { ToastProvider } from './components/Toast';
import { DialogProvider } from './components/Dialog';
import { AuroraBackground } from './components/AuroraBackground';
import { EditionProvider } from './edition';
import { initInteractionFx } from './fx';

export function App() {
  useEffect(() => initInteractionFx(), []);

  return (
    <EditionProvider>
      <ToastProvider>
        <DialogProvider>
          <BrowserRouter>
            <AuroraBackground />
            <div className="app-content">
              <AppRoutes />
            </div>
          </BrowserRouter>
        </DialogProvider>
      </ToastProvider>
    </EditionProvider>
  );
}
