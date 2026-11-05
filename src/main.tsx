import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { closeMenusAfterCommands, holdBrowserNavigationKeys } from './lib/keys'
import { dismissBootSplash } from './lib/boot-splash'

holdBrowserNavigationKeys()
closeMenusAfterCommands()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

dismissBootSplash()
