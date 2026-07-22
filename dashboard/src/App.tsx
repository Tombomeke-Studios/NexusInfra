import { BrowserRouter } from 'react-router-dom';
import { AppRoutes } from './routes';
import { ToastProvider } from './components/Toast';
import { AuroraBackground } from './components/AuroraBackground';

export function App() {
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
