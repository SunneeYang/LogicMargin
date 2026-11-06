import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import '@xyflow/react/dist/style.css'
import '../tokens.css'
import './styles.css'
import './canvas-comments.css'
import './revisions.css'
import './graph-reading.css'
import './reading-themes.css'
import './node-inspection.css'
import './code-diff.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
)
