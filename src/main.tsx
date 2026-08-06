import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// Embed mode: when loaded inside an iframe with ?embed=1 (e.g. from MMX),
// use a transparent background so the app blends into the host page.
if (new URLSearchParams(window.location.search).get('embed') === '1') {
  document.body.classList.add('embed-mode')
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
