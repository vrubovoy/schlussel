import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { applyTheme, getStoredTheme } from '@zudar107/schloss-ui'
import { Root } from './Root'
import './index.css'

applyTheme(getStoredTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
