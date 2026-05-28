import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import OutputView from './OutputView';
import './index.css';

const params = new URLSearchParams(window.location.search);
const view = params.get('view');

ReactDOM.createRoot(document.getElementById('root')).render(
  view === 'output' ? <OutputView /> : <App />
);
