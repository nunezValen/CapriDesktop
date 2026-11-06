import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/cyberpunk.css'
import './styles/cp-ui.css'
import './styles/deck-mac.css'
import { initUserName } from './utils/userName'

initUserName()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
