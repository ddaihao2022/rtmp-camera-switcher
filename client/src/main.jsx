import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import OutputView from './OutputView';
import AudioView from './AudioView';
import './index.css';

const params = new URLSearchParams(window.location.search);
const view = params.get('view');

ReactDOM.createRoot(document.getElementById('root')).render(
  view === 'output' ? <OutputView /> :
  view === 'audio'  ? <AudioView /> :
  <App />
);
