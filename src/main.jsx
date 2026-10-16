import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import markup from './legacyMarkup.html?raw';
import './style.css';

function App() {
  useEffect(() => {
    let cancelled = false;
    // Keep the existing campaign workflows intact while the UI is mounted by React.
    import('./legacy.js').catch((error) => {
      if (!cancelled) {
        const notice = document.getElementById('loginError');
        if (notice) {
          notice.textContent = 'The application could not initialize. Refresh the page and check the browser console.';
          notice.className = 'notice error';
        }
      }
      console.error('Failed to initialize campaign UI:', error);
    });
    return () => { cancelled = true; };
  }, []);

  return <div className="react-app" dangerouslySetInnerHTML={{ __html: markup }} />;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
