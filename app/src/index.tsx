import { render } from 'solid-js/web';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';
import App from './App';
import { pickReachableServer } from './lib/api';

// The desktop app may need the direct address before anything connects (ISPs that block Cloudflare).
void pickReachableServer().then(() => render(() => <App />, document.getElementById('root')!));
